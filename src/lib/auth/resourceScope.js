import { getSettings } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getConsistentMachineId } from "@/shared/utils/machineId";

// Resources created by the password login. Not a valid e-mail, so an IdP claim
// can never impersonate it (normalizeOwner rejects anything starting with "@").
export const ADMIN_OWNER = "@admin";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

const ANONYMOUS = Object.freeze({ isAdmin: false, owner: null });

export function normalizeOwner(value) {
  if (typeof value !== "string") return null;
  const owner = value.trim().toLowerCase();
  if (!owner || owner.startsWith("@")) return null;
  return owner;
}

// Sentinel included: the admin owner is assignable from the dashboard, unlike
// an IdP-supplied claim, which normalizeOwner strips.
export function normalizeOwnerInput(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === ADMIN_OWNER) return ADMIN_OWNER;
  return normalizeOwner(value);
}

export function parseAdminEmails(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/);
  return list.map(normalizeOwner).filter(Boolean);
}

export function isScopeEnabled(settings) {
  return settings?.scopeResourcesByUser === true;
}

let cachedCliToken = null;
async function hasValidCliToken(headerValue) {
  if (!headerValue) return false;
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headerValue === cachedCliToken;
}

// Request-scoped APIs throw outside a request (boot, background refresh, CLI).
// Those callers are trusted server-side paths, not impersonation risks, so the
// absence of a request reads as "no identity" rather than an error.
async function readRequestContext() {
  try {
    const { cookies, headers } = await import("next/headers");
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    return {
      token: cookieStore.get("auth_token")?.value || null,
      cliToken: headerStore.get(CLI_TOKEN_HEADER) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Who is making the current request.
 * `isAdmin` is a session privilege, `owner` is identity — an SSO admin keeps its
 * own e-mail as owner, so losing admin never orphans what belonged to them.
 */
export async function getRequestIdentity() {
  const ctx = await readRequestContext();
  if (!ctx) return ANONYMOUS;

  // The CLI destraps lockouts (reset auth mode) without a dashboard session;
  // treating it as admin keeps that escape hatch working once settings are gated.
  if (await hasValidCliToken(ctx.cliToken)) return { isAdmin: true, owner: null };

  const session = await getDashboardAuthSession(ctx.token);
  if (!session) return ANONYMOUS;

  const owner = normalizeOwner(session.oidcEmail || session.samlEmail);
  if (!owner) return { isAdmin: true, owner: ADMIN_OWNER };

  const settings = await getSettings();
  return { isAdmin: parseAdminEmails(settings?.ssoAdminEmails).includes(owner), owner };
}

/**
 * The visibility predicate for this request, or null for "see everything"
 * (scope disabled, or an admin). Callers pass it to canSee/canEdit.
 */
export async function getScopeFilter() {
  const settings = await getSettings();
  if (!isScopeEnabled(settings)) return null;
  const identity = await getRequestIdentity();
  if (identity.isAdmin) return null;
  return { owner: identity.owner };
}

// Unowned resources are the shared pool: visible and usable by everyone.
/**
 * Owner to stamp on a resource created by the current request.
 *
 * Shared (null) unless a scoped SSO user is creating it: with scoping off
 * nothing is owned, and what the password login creates is the common pool —
 * "@admin" is an explicit choice in the UI, never a default. Lives here, not at
 * the ~23 call sites that create resources, so a new one cannot forget it.
 */
export async function resolveDefaultOwner() {
  try {
    const settings = await getSettings();
    if (!isScopeEnabled(settings)) return null;
    const { owner } = await getRequestIdentity();
    return owner === ADMIN_OWNER ? null : owner;
  } catch {
    return null;
  }
}

export function canSee(resource, filter) {
  if (!filter) return true;
  const owner = resource?.owner ?? null;
  return owner === null || owner === filter.owner;
}

// Same reach as canSee: a shared resource stays editable by whoever can see it.
// Admin-only resources never reach here — a non-admin filter excludes them.
export function canEdit(resource, filter) {
  return canSee(resource, filter);
}

export function scopeVisible(resources, filter) {
  if (!filter) return resources;
  return resources.filter((resource) => canSee(resource, filter));
}

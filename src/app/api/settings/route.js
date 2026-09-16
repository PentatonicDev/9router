import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { getRequestIdentity, isScopeEnabled, isSsoOnly, parseAdminEmails } from "@/lib/auth/resourceScope";
import { TOKEN_SAVER_KEYS, resolveTokenSaverFor } from "@/lib/auth/scopedSettings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

// An external Headroom (a URL that is not loopback) is the operator's own
// deployment and always counts as set up; a local one has to be installed.
async function isHeadroomReady(settings) {
  try {
    const { getHeadroomStatus, DEFAULT_HEADROOM_URL } = await import("@/lib/headroom/detect");
    const status = await getHeadroomStatus(settings?.headroomUrl || DEFAULT_HEADROOM_URL);
    return !status.localUrl || status.installed || status.running;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";

    // A scoped user edits their own token-saver overrides, so hand back the
    // effective view — theirs where set, the admin's otherwise — plus which keys
    // are inherited, so the dashboard can say so instead of showing the global
    // value as if the user had chosen it.
    const identity = await getRequestIdentity();
    let tokenSaverInherited = [];
    if (isScopeEnabled(settings) && !identity.isAdmin && identity.owner) {
      const { effective, overridden } = resolveTokenSaverFor(settings, identity.owner);
      Object.assign(safeSettings, effective);
      tokenSaverInherited = TOKEN_SAVER_KEYS.filter((k) => !overridden.includes(k));
      const ownAdapter = settings.capacityAdapterByOwner?.[identity.owner];
      if (ownAdapter) safeSettings.capacityAdapter = ownAdapter;
    }
    delete safeSettings.tokenSaverByOwner;
    delete safeSettings.capacityAdapterByOwner;

    return NextResponse.json({
      ...safeSettings,
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password,
      tokenSaverInherited,
      tokenSaverScoped: isScopeEnabled(settings) && !identity.isAdmin && !!identity.owner,
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // Settings are global: without this gate a scoped user could PATCH
    // scopeResourcesByUser:false and lift their own restriction — along with
    // auth mode, SSO config and requireApiKey.
    const current = await getSettings();
    if (isScopeEnabled(current)) {
      const identity = await getRequestIdentity();
      if (!identity.isAdmin) {
        // Narrow exception: a scoped user owns their own vision adapter and
        // token-saver flags, which live inside this global blob rather than in
        // tables of their own. Anything else here is global configuration.
        const OWN_KEYS = new Set(["capacityAdapter", ...TOKEN_SAVER_KEYS]);
        const touched = Object.keys(body);
        if (!identity.owner || !touched.length || !touched.every((k) => OWN_KEYS.has(k))) {
          return NextResponse.json({ error: "Admin access required" }, { status: 403 });
        }

        if (body.capacityAdapter !== undefined) {
          body.capacityAdapterByOwner = { ...(current.capacityAdapterByOwner || {}), [identity.owner]: body.capacityAdapter };
          delete body.capacityAdapter;
        }

        // Headroom is infrastructure the admin installs and starts. A user may
        // only opt in or out of one that is already set up — otherwise the flag
        // would point at a proxy that is not there, and every request would pay
        // the timeout before failing open.
        if (body.headroomEnabled === true && !(await isHeadroomReady(current))) {
          return NextResponse.json(
            { error: "Headroom is not set up on this instance. Ask an admin to install it." },
            { status: 409 }
          );
        }

        const ownSaver = { ...(current.tokenSaverByOwner?.[identity.owner] || {}) };
        for (const key of TOKEN_SAVER_KEYS) {
          if (body[key] === undefined) continue;
          // null clears the override, putting the user back on the global value.
          if (body[key] === null) delete ownSaver[key];
          else ownSaver[key] = body[key];
          delete body[key];
        }
        body.tokenSaverByOwner = { ...(current.tokenSaverByOwner || {}), [identity.owner]: ownSaver };
      }
    }

    // SSO-only leaves no password login, so an instance without a designated
    // admin would have nobody able to administer it.
    const ssoOnly = isSsoOnly({ ...current, ...body });
    if (ssoOnly && isScopeEnabled({ ...current, ...body })) {
      const admins = parseAdminEmails(body.ssoAdminEmails ?? current.ssoAdminEmails);
      if (!admins.length) {
        return NextResponse.json(
          { error: "At least one admin e-mail is required when SSO is the only login method" },
          { status: 400 }
        );
      }
    }
    if (body.ssoAdminEmails !== undefined) body.ssoAdminEmails = parseAdminEmails(body.ssoAdminEmails);

    // If updating password, hash it
    if (body.newPassword) {
      const currentHash = current.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);

    // A scoped user gets their own effective view back, not the global blob:
    // echoing every setting here would hand out the whole configuration they
    // are not allowed to read.
    const patchIdentity = await getRequestIdentity();
    if (isScopeEnabled(settings) && !patchIdentity.isAdmin && patchIdentity.owner) {
      const { effective, overridden } = resolveTokenSaverFor(settings, patchIdentity.owner);
      return NextResponse.json({
        ...effective,
        capacityAdapter: settings.capacityAdapterByOwner?.[patchIdentity.owner] ?? settings.capacityAdapter,
        tokenSaverInherited: TOKEN_SAVER_KEYS.filter((k) => !overridden.includes(k)),
        tokenSaverScoped: true,
      }, { headers: SETTINGS_RESPONSE_HEADERS });
    }

    delete safeSettings.tokenSaverByOwner;
    delete safeSettings.capacityAdapterByOwner;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

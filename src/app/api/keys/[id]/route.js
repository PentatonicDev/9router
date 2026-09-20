import { NextResponse } from "next/server";
import {
  deleteApiKey, getApiKeyById, updateApiKey, getProviderConnections,
  getAdminKeyByOwner, isAdminOwnerConflict, normalizeConnectionBudgets,
} from "@/lib/localDb";
import { canSee, getRequestIdentity, getScopeFilter, normalizeOwnerInput, scopeVisible } from "@/lib/auth/resourceScope";

const MAX_NAME_LENGTH = 100;

// Returns the accepted id list, or an { error } describing why it was rejected.
// An empty list is valid and means "unrestricted".
async function validateAllowedConnectionIds(value, filter) {
  if (value === null) return { ids: null };
  if (!Array.isArray(value)) return { error: "allowedConnectionIds must be an array or null" };
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  if (ids.length !== value.length) return { error: "allowedConnectionIds must contain non-empty strings" };
  if (ids.length === 0) return { ids: null };
  // Scoped to what the caller can see, so an unknown-id error cannot be used to
  // probe for accounts owned by someone else.
  const existing = new Set(scopeVisible(await getProviderConnections(), filter).map((c) => c.id));
  const unknown = ids.filter((id) => !existing.has(id));
  if (unknown.length) return { error: `Unknown connection ids: ${unknown.join(", ")}` };
  return { ids: Array.from(new Set(ids)) };
}

// Returns the accepted budgets map, or an { error } describing why it was
// rejected. Unlike normalizeConnectionBudgets's silent pruning on an owner
// change (the map narrowing underneath the caller), a budget on a connection
// this same request leaves unbound is a mistake in the request itself, so it
// 400s instead — `allowedConnectionIds` is the resolved value after this same
// PUT applies its own binding change, not the stored one.
function validateConnectionBudgets(value, allowedConnectionIds) {
  if (value === null) return { budgets: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "connectionBudgets must be an object or null" };
  }
  const allowed = allowedConnectionIds ? new Set(allowedConnectionIds) : null;
  for (const [connId, budget] of Object.entries(value)) {
    if (allowed && !allowed.has(connId)) {
      return { error: `connectionBudgets has a connection id this key cannot route to: ${connId}` };
    }
    if (!budget || typeof budget !== "object" || !(Number(budget.limitUsd) > 0)) {
      return { error: `connectionBudgets.${connId}.limitUsd must be a number greater than 0` };
    }
    if (budget.period !== "month" && budget.period !== "total") {
      return { error: `connectionBudgets.${connId}.period must be "month" or "total"` };
    }
  }
  return { budgets: normalizeConnectionBudgets(value, allowedConnectionIds) };
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key || !canSee(key, await getScopeFilter())) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, allowedConnectionIds, connectionBudgets, name, tags, owner, kind } = body;

    const filter = await getScopeFilter();
    const existing = await getApiKeyById(id);
    if (!existing || !canSee(existing, filter)) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return NextResponse.json({ error: "Name must be a non-empty string" }, { status: 400 });
      }
      updateData.name = name.trim().slice(0, MAX_NAME_LENGTH);
    }
    if (tags !== undefined) {
      if (tags !== null && !Array.isArray(tags)) {
        return NextResponse.json({ error: "tags must be an array or null" }, { status: 400 });
      }
      if (Array.isArray(tags) && tags.some((t) => typeof t !== "string")) {
        return NextResponse.json({ error: "tags must contain only strings" }, { status: 400 });
      }
      updateData.tags = tags;
    }
    if (allowedConnectionIds !== undefined) {
      const validated = await validateAllowedConnectionIds(allowedConnectionIds, filter);
      if (validated.error) return NextResponse.json({ error: validated.error }, { status: 400 });
      updateData.allowedConnectionIds = validated.ids;
    }
    if (connectionBudgets !== undefined) {
      const effectiveAllowedConnectionIds = allowedConnectionIds !== undefined
        ? updateData.allowedConnectionIds : existing.allowedConnectionIds;
      const validated = validateConnectionBudgets(connectionBudgets, effectiveAllowedConnectionIds);
      if (validated.error) return NextResponse.json({ error: validated.error }, { status: 400 });
      updateData.connectionBudgets = validated.budgets;
    }
    // Reassigning an owner, or changing kind, is an admin action; a non-admin
    // caller's value is silently ignored, never a 400.
    if (owner !== undefined || kind !== undefined) {
      const { isAdmin } = await getRequestIdentity();
      if (isAdmin) {
        if (kind !== undefined && kind !== "usage" && kind !== "admin") {
          return NextResponse.json({ error: 'kind must be "usage" or "admin"' }, { status: 400 });
        }
        const effectiveOwner = owner !== undefined ? normalizeOwnerInput(owner) : existing.owner;
        const effectiveKind = kind !== undefined ? kind : existing.kind;
        if (effectiveKind === "admin") {
          if (!effectiveOwner) {
            return NextResponse.json({ error: "Administration key requires an owner" }, { status: 400 });
          }
          if (await getAdminKeyByOwner(effectiveOwner, id)) {
            return NextResponse.json({ error: "Owner already has an administration key" }, { status: 409 });
          }
        }
        if (owner !== undefined) updateData.owner = effectiveOwner;
        if (kind !== undefined) updateData.kind = kind;
      }
    }

    let updated;
    try {
      updated = await updateApiKey(id, updateData);
    } catch (error) {
      // Same TOCTOU gap as the POST pre-check: two concurrent admin-kind
      // edits/rotates for the same owner can both pass getAdminKeyByOwner and
      // race to idx_ak_admin_owner, which rejects the loser.
      if (updateData.kind === "admin" && isAdminOwnerConflict(error)) {
        return NextResponse.json({ error: "Owner already has an administration key" }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getApiKeyById(id);
    if (!existing || !canSee(existing, await getScopeFilter())) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}

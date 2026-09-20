import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getAdminKeyByOwner, isAdminOwnerConflict } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getRequestIdentity, getScopeFilter, normalizeOwnerInput, ownerForCreate, scopeVisible } from "@/lib/auth/resourceScope";

export const dynamic = "force-dynamic";

const MAX_NAME_LENGTH = 100;

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = scopeVisible(await getApiKeys(), await getScopeFilter());
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, tags } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (tags !== undefined && tags !== null && !Array.isArray(tags)) {
      return NextResponse.json({ error: "tags must be an array or null" }, { status: 400 });
    }

    if (body.kind !== undefined && body.kind !== "usage" && body.kind !== "admin") {
      return NextResponse.json({ error: 'kind must be "usage" or "admin"' }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    // Anyone may mint an administration key: a non-admin's is stamped with
    // their own identity below, so it can only ever carry that caller's own
    // scope (one per owner, enforced below and by idx_ak_admin_owner).
    const identity = await getRequestIdentity();
    const kind = body.kind === "admin" ? "admin" : "usage";
    // An admin key with no owner could never authenticate as anyone
    // (resourceScope.getRequestIdentity requires keyCtx.owner), so it never
    // takes the shared-pool default a routing key gets: an admin picks the
    // owner (their own identity when omitted), everyone else gets their own.
    const owner = kind === "admin"
      ? (identity.isAdmin && body.owner !== undefined ? normalizeOwnerInput(body.owner) : identity.owner)
      : await ownerForCreate(body.owner);

    if (kind === "admin") {
      if (!owner) {
        return NextResponse.json({ error: "Administration key requires an owner" }, { status: 400 });
      }
      if (await getAdminKeyByOwner(owner)) {
        return NextResponse.json({ error: "Owner already has an administration key" }, { status: 409 });
      }
    }

    let apiKey;
    try {
      apiKey = await createApiKey(
        name.trim().slice(0, MAX_NAME_LENGTH), machineId, tags ?? null, owner, kind,
      );
    } catch (error) {
      // The pre-check above has a TOCTOU gap: two concurrent admin-key creates
      // for the same owner can both pass it and race to idx_ak_admin_owner,
      // which rejects the loser. Surface that as the same 409 the pre-check
      // gives the common case, not a generic 500.
      if (kind === "admin" && isAdminOwnerConflict(error)) {
        return NextResponse.json({ error: "Owner already has an administration key" }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      tags: apiKey.tags,
      owner: apiKey.owner,
      kind: apiKey.kind,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}

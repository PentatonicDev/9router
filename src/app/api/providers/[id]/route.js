import { NextResponse } from "next/server";
import { canSee, getRequestIdentity, getScopeFilter, normalizeOwnerInput } from "@/lib/auth/resourceScope";
import { isScopeEnabled } from "@/lib/auth/resourceScope";
import { getSettings } from "@/lib/localDb";
import { setAccountDisabled } from "@/lib/db/repos/disabledAccountsRepo.js";

// A shared account (no owner) is the admin's to change. Everyone else may use
// it and switch it off for themselves, but editing or deleting it would affect
// every other user, so those stay with the admin.
async function sharedAccountGuard(connection) {
  if ((connection?.owner ?? null) !== null) return null;
  if (!isScopeEnabled(await getSettings())) return null;
  if ((await getRequestIdentity()).isAdmin) return null;
  return { error: "Shared accounts are managed by the admin", status: 403 };
}
import {
  getProviderConnectionById,
  getProxyPoolById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";

function normalizeProxyConfig(body = {}) {
  const hasAnyProxyField =
    Object.prototype.hasOwnProperty.call(body, "connectionProxyEnabled") ||
    Object.prototype.hasOwnProperty.call(body, "connectionProxyUrl") ||
    Object.prototype.hasOwnProperty.call(body, "connectionNoProxy");

  if (!hasAnyProxyField) return { hasAnyProxyField: false };

  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return {
      hasAnyProxyField: true,
      error: "Connection proxy URL is required when connection proxy is enabled",
    };
  }

  return {
    hasAnyProxyField: true,
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolUpdate(proxyPoolIdInput) {
  if (proxyPoolIdInput === undefined) {
    return { hasProxyPoolField: false, proxyPoolId: null };
  }

  if (proxyPoolIdInput === null || proxyPoolIdInput === "" || proxyPoolIdInput === "__none__") {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPoolId = String(proxyPoolIdInput).trim();
  if (!proxyPoolId) {
    return { hasProxyPoolField: true, proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(proxyPoolId);
  if (!proxyPool) {
    return { hasProxyPoolField: true, error: "Proxy pool not found" };
  }

  return { hasProxyPoolField: true, proxyPoolId };
}

function shouldMergeProviderSpecificData(existing, incoming, hasLegacyProxy, hasProxyPoolField) {
  return existing !== undefined || incoming !== undefined || hasLegacyProxy || hasProxyPoolField;
}

// GET /api/providers/[id] - Get single connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection || !canSee(connection, await getScopeFilter())) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Hide sensitive fields
    const result = { ...connection };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error fetching connection:", error);
    return NextResponse.json({ error: "Failed to fetch connection" }, { status: 500 });
  }
}

// PUT /api/providers/[id] - Update connection
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      priority,
      globalPriority,
      defaultModel,
      isActive,
      apiKey,
      testStatus,
      lastError,
      lastErrorAt,
      providerSpecificData,
      owner
    } = body;

    const existing = await getProviderConnectionById(id);
    if (!existing || !canSee(existing, await getScopeFilter())) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Turning a shared account off for yourself is the one change a non-admin
    // may make to it, and it is recorded per user rather than on the account.
    const identity = await getRequestIdentity();
    if ((existing.owner ?? null) === null && !identity.isAdmin && identity.owner
        && isScopeEnabled(await getSettings())) {
      const onlyActive = Object.keys(body).length === 1 && isActive !== undefined;
      if (!onlyActive) {
        return NextResponse.json({ error: "Shared accounts are managed by the admin" }, { status: 403 });
      }
      await setAccountDisabled(identity.owner, id, isActive === false);
      return NextResponse.json({ connection: { ...existing, isActive: isActive !== false, disabledForMe: isActive === false } });
    }

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    const proxyPoolResult = await normalizeProxyPoolUpdate(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return NextResponse.json({ error: proxyPoolResult.error }, { status: 400 });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (priority !== undefined) updateData.priority = priority;
    if (globalPriority !== undefined) updateData.globalPriority = globalPriority;
    if (defaultModel !== undefined) updateData.defaultModel = defaultModel;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (apiKey && existing.authType === "apikey") updateData.apiKey = apiKey;
    if (testStatus !== undefined) updateData.testStatus = testStatus;
    if (lastError !== undefined) updateData.lastError = lastError;
    if (lastErrorAt !== undefined) updateData.lastErrorAt = lastErrorAt;
    // Reassigning an owner is an admin action; other callers keep the current one.
    if (owner !== undefined && (await getRequestIdentity()).isAdmin) {
      updateData.owner = normalizeOwnerInput(owner);
    }

    if (
      shouldMergeProviderSpecificData(
        existing.providerSpecificData,
        providerSpecificData,
        proxyConfig.hasAnyProxyField,
        proxyPoolResult.hasProxyPoolField
      )
    ) {
      updateData.providerSpecificData = {
        ...(existing.providerSpecificData || {}),
        ...(providerSpecificData || {}),
      };

      if (proxyConfig.hasAnyProxyField) {
        updateData.providerSpecificData.connectionProxyEnabled = proxyConfig.connectionProxyEnabled;
        updateData.providerSpecificData.connectionProxyUrl = proxyConfig.connectionProxyUrl;
        updateData.providerSpecificData.connectionNoProxy = proxyConfig.connectionNoProxy;
      }

      if (proxyPoolResult.hasProxyPoolField) {
        if (proxyPoolResult.proxyPoolId === null) {
          delete updateData.providerSpecificData.proxyPoolId;
        } else {
          updateData.providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;
        }
      }
    }

    const updated = await updateProviderConnection(id, updateData);

    // Hide sensitive fields
    const result = { ...updated };
    delete result.apiKey;
    delete result.accessToken;
    delete result.refreshToken;
    delete result.idToken;

    return NextResponse.json({ connection: result });
  } catch (error) {
    console.log("Error updating connection:", error);
    return NextResponse.json({ error: "Failed to update connection" }, { status: 500 });
  }
}

// DELETE /api/providers/[id] - Delete connection
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getProviderConnectionById(id);
    if (!existing || !canSee(existing, await getScopeFilter())) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    const denied = await sharedAccountGuard(existing);
    if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

    const deleted = await deleteProviderConnection(id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Connection deleted successfully" });
  } catch (error) {
    console.log("Error deleting connection:", error);
    return NextResponse.json({ error: "Failed to delete connection" }, { status: 500 });
  }
}

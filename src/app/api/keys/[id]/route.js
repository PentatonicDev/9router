import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey, getProviderConnections } from "@/lib/localDb";

// Returns the accepted id list, or an { error } describing why it was rejected.
// An empty list is valid and means "unrestricted".
async function validateAllowedConnectionIds(value) {
  if (value === null) return { ids: null };
  if (!Array.isArray(value)) return { error: "allowedConnectionIds must be an array or null" };
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  if (ids.length !== value.length) return { error: "allowedConnectionIds must contain non-empty strings" };
  if (ids.length === 0) return { ids: null };
  const existing = new Set((await getProviderConnections()).map((c) => c.id));
  const unknown = ids.filter((id) => !existing.has(id));
  if (unknown.length) return { error: `Unknown connection ids: ${unknown.join(", ")}` };
  return { ids: Array.from(new Set(ids)) };
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
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
    const { isActive, allowedConnectionIds } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (allowedConnectionIds !== undefined) {
      const validated = await validateAllowedConnectionIds(allowedConnectionIds);
      if (validated.error) return NextResponse.json({ error: validated.error }, { status: 400 });
      updateData.allowedConnectionIds = validated.ids;
    }

    const updated = await updateApiKey(id, updateData);

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

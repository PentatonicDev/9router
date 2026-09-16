import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { getRequestIdentity, getScopeFilter, scopeVisible } from "@/lib/auth/resourceScope";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const filter = await getScopeFilter();
    const { isAdmin } = await getRequestIdentity();
    // A shared combo stays usable by everyone but is only editable by an admin,
    // so the UI can render it read-only instead of hiding it.
    const combos = scopeVisible(await getCombos(), filter).map((combo) => ({
      ...combo,
      readOnly: !isAdmin && (combo.owner ?? null) === null,
    }));
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Names are unique per owner, so only a clash within the caller's own scope
    // blocks creation — another user may already own a combo with this name.
    const { owner } = await getRequestIdentity();
    const existing = await getComboByName(name, owner);
    if (existing && (existing.owner ?? null) === (owner ?? null)) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    const combo = await createCombo({ name, models: models || [], kind: kind || null });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}

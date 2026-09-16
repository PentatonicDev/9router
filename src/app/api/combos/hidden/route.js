import { NextResponse } from "next/server";
import { getRequestIdentity } from "@/lib/auth/resourceScope";
import { getHiddenComboNames, hideGlobalCombo, unhideGlobalCombo } from "@/lib/db/repos/hiddenCombosRepo.js";

export const dynamic = "force-dynamic";

// Hiding is per user, so an admin (who owns the shared combos) has nothing here.
async function requireScopedUser() {
  const { owner, isAdmin } = await getRequestIdentity();
  if (isAdmin || !owner) return null;
  return owner;
}

export async function GET() {
  const owner = await requireScopedUser();
  if (!owner) return NextResponse.json({ names: [] });
  return NextResponse.json({ names: await getHiddenComboNames(owner) });
}

// POST { name, hidden: true|false }
export async function POST(request) {
  try {
    const owner = await requireScopedUser();
    if (!owner) return NextResponse.json({ error: "Not applicable for this account" }, { status: 403 });

    const { name, hidden } = await request.json();
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    if (hidden === false) {
      const ok = await unhideGlobalCombo(owner, name.trim());
      if (!ok) {
        return NextResponse.json(
          { error: `Delete your own "${name.trim()}" combo before restoring the shared one.` },
          { status: 409 }
        );
      }
    } else {
      await hideGlobalCombo(owner, name.trim());
    }

    return NextResponse.json({ names: await getHiddenComboNames(owner) });
  } catch (error) {
    console.log("Error updating hidden combos:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

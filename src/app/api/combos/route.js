import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { getHiddenComboNames } from "@/lib/db/repos/hiddenCombosRepo.js";
import { getRequestIdentity, getScopeFilter, ownerForCreate, scopeVisible } from "@/lib/auth/resourceScope";
import { THINKING_ORDER } from "open-sse/translator/concerns/thinking.js";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// combo.modelOptions: { [modelEntryString]: { maxThinking: <THINKING_ORDER level> } }.
// Absent/null is valid (no caps set); an unrecognized maxThinking level is rejected
// outright rather than silently ignored, so a typo in a client PUT/POST is caught here.
export function isValidModelOptions(modelOptions) {
  if (modelOptions === undefined || modelOptions === null) return true;
  if (typeof modelOptions !== "object" || Array.isArray(modelOptions)) return false;
  return Object.values(modelOptions).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return entry.maxThinking === undefined || THINKING_ORDER.includes(entry.maxThinking);
  });
}

// combo.maxThinking: same THINKING_ORDER level, applied across every model in
// the combo (a per-model cap below it still wins). Absent/null is valid.
export function isValidMaxThinking(maxThinking) {
  return maxThinking === undefined || maxThinking === null || THINKING_ORDER.includes(maxThinking);
}

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const filter = await getScopeFilter();
    const identity = await getRequestIdentity();
    const { isAdmin } = identity;
    const hidden = new Set(isAdmin ? [] : await getHiddenComboNames(identity.owner));
    const combos = scopeVisible(await getCombos(), filter)
      .filter((combo) => !((combo.owner ?? null) === null && hidden.has(combo.name)))
      .map((combo) => ({
        ...combo,
        // Shared combos are usable by everyone but only an admin edits them.
        readOnly: !isAdmin && (combo.owner ?? null) === null,
        shared: (combo.owner ?? null) === null,
      }));
    return NextResponse.json({ combos, hiddenSharedCombos: [...hidden] });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind, modelOptions, maxThinking } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    if (!isValidModelOptions(modelOptions)) {
      return NextResponse.json({ error: "Invalid modelOptions: unknown maxThinking level" }, { status: 400 });
    }

    if (!isValidMaxThinking(maxThinking)) {
      return NextResponse.json({ error: "Invalid maxThinking level" }, { status: 400 });
    }

    // Names are unique per owner, so only a clash within the caller's own scope
    // blocks creation — another user may already own a combo with this name.
    const { owner, isAdmin } = await getRequestIdentity();
    const existing = await getComboByName(name, owner);
    if (existing && (existing.owner ?? null) === (owner ?? null)) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }
    // A shared combo's name is taken for everyone: two combos answering to the
    // same name would be ambiguous at routing time. Hiding the shared one frees
    // the name for that user.
    if (!isAdmin && existing && (existing.owner ?? null) === null) {
      return NextResponse.json(
        { error: `"${name}" is a shared combo. Hide it first to reuse the name.`, sharedNameTaken: true },
        { status: 409 }
      );
    }

    const combo = await createCombo({
      name, models: models || [], kind: kind || null, modelOptions: modelOptions || null,
      maxThinking: maxThinking || null,
      owner: await ownerForCreate(body.owner),
    });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}

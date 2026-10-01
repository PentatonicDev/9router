import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { getHiddenComboNames } from "@/lib/db/repos/hiddenCombosRepo.js";
import { getRequestIdentity, getScopeFilter, ownerForCreate, resolveDefaultOwner, scopeVisible } from "@/lib/auth/resourceScope";
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

// Returns the cleaned alias list, or { error } for the first bad entry.
export function normalizeAliases(aliases, name) {
  if (aliases === undefined || aliases === null) return { aliases: [] };
  if (!Array.isArray(aliases)) return { error: "aliases must be an array" };
  const out = [];
  for (const raw of aliases) {
    const alias = typeof raw === "string" ? raw.trim() : "";
    if (!VALID_NAME_REGEX.test(alias)) return { error: `Invalid alias "${raw}": only letters, numbers, -, _ and .` };
    if (alias === name) return { error: `Alias "${alias}" is the combo's own name` };
    if (!out.includes(alias)) out.push(alias);
  }
  return { aliases: out };
}

// Every name a combo answers to must be free in its owner's scope, and (for
// non-admins) not taken by a shared combo either: routing would be ambiguous.
export async function findNameClash(names, owner, selfId, isAdmin) {
  for (const n of names) {
    const hit = await getComboByName(n, owner ?? null);
    if (!hit || hit.id === selfId) continue;
    const sameScope = (hit.owner ?? null) === (owner ?? null);
    if (sameScope || !isAdmin) return { name: n, combo: hit, shared: !sameScope };
  }
  return null;
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

    const { aliases, error: aliasError } = normalizeAliases(body.aliases, name);
    if (aliasError) return NextResponse.json({ error: aliasError }, { status: 400 });

    // Names are unique per owner, so only a clash within the owner the combo will
    // land on blocks creation — another user may already own one with this name.
    const { isAdmin } = await getRequestIdentity();
    const requestedOwner = await ownerForCreate(body.owner);
    const owner = requestedOwner === undefined ? await resolveDefaultOwner() : requestedOwner;
    const clash = await findNameClash([name, ...aliases], owner, null, isAdmin);
    if (clash?.shared) {
      // Hiding the shared one frees the name for that user.
      return NextResponse.json(
        { error: `"${clash.name}" is used by shared combo "${clash.combo.name}". Hide it first to reuse the name.`, sharedNameTaken: true },
        { status: 409 }
      );
    }
    if (clash) {
      return NextResponse.json({ error: clash.name === name ? "Combo name already exists" : `"${clash.name}" is already used by combo "${clash.combo.name}"` }, { status: 400 });
    }

    const combo = await createCombo({
      name, models: models || [], kind: kind || null, modelOptions: modelOptions || null,
      maxThinking: maxThinking || null,
      aliases,
      owner,
    });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}

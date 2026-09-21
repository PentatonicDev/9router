// EditConnectionModal.js's buildBedrockSpecificData() used to omit
// authMethod from the object it builds. That silently broke Bedrock IAM
// edits: validate/route.js's isBedrockIam check requires
// providerSpecificData.authMethod === "iam", so a payload missing it falls
// into the generic "apiKey required" guard and always 400s — the edit
// modal's "Validate" (and handleSubmit's implicit pre-save validate) always
// reported the credential as invalid, even when correct, so testStatus
// could never flip to "active" via an edit.
//
// EditConnectionModal.js is a React component ("use client") with no
// jsdom/RTL harness in this repo, so it isn't rendered here. Instead this
// locks two things: (1) the exact source line inside buildBedrockSpecificData
// that must set authMethod — scoped to that function's body only, so it
// can't pass by matching one of the OTHER authMethod occurrences in the file
// (initial state, the useEffect hydration) — and (2) the real validate route
// consequence, proving why the missing field mattered.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.resolve(__dirname, "../../src/shared/components/EditConnectionModal.js");

function extractFunctionBody(source, fnDeclaration) {
  const start = source.indexOf(fnDeclaration);
  if (start === -1) throw new Error(`declaration not found: ${fnDeclaration}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

describe("EditConnectionModal buildBedrockSpecificData source contract", () => {
  it("sets authMethod inside the function that builds the bedrock payload", () => {
    const source = fs.readFileSync(componentPath, "utf8");
    const body = extractFunctionBody(source, "const buildBedrockSpecificData = () => {");
    expect(body).toMatch(/authMethod:\s*bedrockData\.authMethod/);
  });
});

// creditsUsd: same no-RTM-harness constraint as above, so these run the
// actual extracted source blocks (hydration effect + buildBedrockSpecificData)
// via `new Function` against controlled inputs, rather than just pattern-
// matching text — proving the real pre-fill/clear/parse behavior, not just
// that some matching line exists.
describe("EditConnectionModal bedrock creditsUsd", () => {
  const source = fs.readFileSync(componentPath, "utf8");

  function runHydration(connection) {
    let captured;
    const setBedrockData = (v) => { captured = v; };
    const block = extractFunctionBody(source, 'if (connection.provider === "bedrock") {');
    const fn = new Function("connection", "setBedrockData", block);
    fn(connection, setBedrockData);
    return captured;
  }

  it("pre-fills creditsUsd as a string when psd has a numeric value (250 -> \"250\")", () => {
    expect(runHydration({ provider: "bedrock", providerSpecificData: { creditsUsd: 250 } }).creditsUsd).toBe("250");
  });

  it("leaves creditsUsd blank when psd has none", () => {
    expect(runHydration({ provider: "bedrock", providerSpecificData: {} }).creditsUsd).toBe("");
  });

  function runBuild(creditsUsdInput) {
    const bedrockData = {
      authMethod: "api_key",
      region: "us-east-1",
      homeRegion: "",
      inferenceProfilePrefix: "",
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
      creditsUsd: creditsUsdInput,
    };
    const body = extractFunctionBody(source, "const buildBedrockSpecificData = () => {");
    const fn = new Function("bedrockData", "isBedrockIam", "isBedrockGlobal", body);
    return fn(bedrockData, false, false);
  }

  it("submits creditsUsd: null when the field is cleared (blank string)", () => {
    expect(runBuild("").creditsUsd).toBeNull();
  });

  it("submits creditsUsd: null for a non-positive or non-numeric value", () => {
    expect(runBuild("0").creditsUsd).toBeNull();
    expect(runBuild("-5").creditsUsd).toBeNull();
    expect(runBuild("abc").creditsUsd).toBeNull();
  });

  it("submits the parsed number for a valid value (\"1000.5\" -> 1000.5)", () => {
    expect(runBuild("1000.5").creditsUsd).toBe(1000.5);
  });
});

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient { constructor(config) { this.config = config; } }
  return { BedrockRuntimeClient };
});

vi.mock("@aws-sdk/client-bedrock", () => {
  class ListFoundationModelsCommand { constructor(input) { this.input = input; } }
  class BedrockClient {
    constructor(config) { this.config = config; }
    send(...args) { return sendMock(...args); }
  }
  return { BedrockClient, ListFoundationModelsCommand };
});

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let validatePOST;

beforeEach(async () => {
  sendMock.mockReset().mockResolvedValue({});
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-edit-modal-validate-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  ({ POST: validatePOST } = await import("@/app/api/providers/validate/route.js"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function validateRequest(body) {
  return new Request("https://x.local/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("consequence: validate route needs the authMethod the fix now sends", () => {
  it("400s the pre-fix shape (iam creds, no apiKey, authMethod missing)", async () => {
    const res = await validatePOST(validateRequest({
      provider: "bedrock",
      apiKey: "",
      providerSpecificData: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    }));
    expect(res.status).toBe(400);
  });

  it("validates the fixed shape (same creds, authMethod: 'iam' included)", async () => {
    const res = await validatePOST(validateRequest({
      provider: "bedrock",
      apiKey: "",
      providerSpecificData: { authMethod: "iam", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "shh" },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
  });
});

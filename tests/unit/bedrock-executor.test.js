/**
 * Unit tests for open-sse/executors/bedrock.js
 *
 * The SDK client is mocked — no network calls. Verifies:
 *  - api_key mode sets `token` + authSchemePreference, never `credentials`
 *  - iam mode sets `credentials`, never `token`/authSchemePreference
 *  - a successful ConverseStreamCommand is re-encoded as SSE-of-JSON lines
 *  - a thrown SDK exception maps to the right HTTP status instead of throwing
 *    out of execute() (BUG #6 — chatCore's outer catch would otherwise collapse
 *    every Bedrock failure to a flat 502)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
const clientConfigs = [];

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class ConverseStreamCommand {
    constructor(input) { this.input = input; }
  }
  class BedrockRuntimeClient {
    constructor(config) {
      this.config = config;
      clientConfigs.push(config);
    }
    send(...args) { return sendMock(...args); }
  }
  return { BedrockRuntimeClient, ConverseStreamCommand };
});

const { BedrockExecutor } = await import("../../open-sse/executors/bedrock.js");

function fakeConverseStream(events) {
  return {
    stream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("BedrockExecutor — credential branching", () => {
  beforeEach(() => { sendMock.mockReset(); clientConfigs.length = 0; });

  it("api_key mode: sets token + authSchemePreference, never credentials", async () => {
    sendMock.mockResolvedValue(fakeConverseStream([{ messageStop: { stopReason: "end_turn" } }]));
    const executor = new BedrockExecutor();
    await executor.execute({
      model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      body: { messages: [] },
      credentials: { apiKey: "bearer-secret", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } },
      log: { warn: vi.fn() },
    });

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0].token).toEqual({ token: "bearer-secret" });
    expect(clientConfigs[0].credentials).toBeUndefined();
    expect(clientConfigs[0].authSchemePreference).toEqual(["httpBearerAuth"]);
  });

  it("iam mode: sets credentials, never token/authSchemePreference", async () => {
    sendMock.mockResolvedValue(fakeConverseStream([{ messageStop: { stopReason: "end_turn" } }]));
    const executor = new BedrockExecutor();
    await executor.execute({
      model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      body: { messages: [] },
      credentials: {
        providerSpecificData: {
          authMethod: "iam", region: "us-west-2",
          accessKeyId: "AKIA123", secretAccessKey: "shh", sessionToken: "tok",
        },
      },
      log: { warn: vi.fn() },
    });

    expect(clientConfigs[0].credentials).toEqual({ accessKeyId: "AKIA123", secretAccessKey: "shh", sessionToken: "tok" });
    expect(clientConfigs[0].token).toBeUndefined();
    expect(clientConfigs[0].authSchemePreference).toBeUndefined();
  });

  it("two concurrent connections never share a client (per-request construction)", async () => {
    sendMock.mockResolvedValue(fakeConverseStream([{ messageStop: { stopReason: "end_turn" } }]));
    const executor = new BedrockExecutor();
    const credsA = { apiKey: "token-A", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } };
    const credsB = { apiKey: "token-B", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } };
    await Promise.all([
      executor.execute({ model: "m", body: {}, credentials: credsA, log: { warn: vi.fn() } }),
      executor.execute({ model: "m", body: {}, credentials: credsB, log: { warn: vi.fn() } }),
    ]);
    expect(clientConfigs).toHaveLength(2);
    const tokens = clientConfigs.map((c) => c.token.token).sort();
    expect(tokens).toEqual(["token-A", "token-B"]);
  });

  it("applies inferenceProfilePrefix to modelId sent to Converse", async () => {
    sendMock.mockResolvedValue(fakeConverseStream([{ messageStop: { stopReason: "end_turn" } }]));
    const executor = new BedrockExecutor();
    await executor.execute({
      model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      body: { messages: [] },
      credentials: { apiKey: "x", providerSpecificData: { authMethod: "api_key", region: "us-east-1", inferenceProfilePrefix: "us." } },
      log: { warn: vi.fn() },
    });
    const [command] = sendMock.mock.calls[0];
    expect(command.input.modelId).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("does not double-prefix a model id that already carries a geo prefix", async () => {
    sendMock.mockResolvedValue(fakeConverseStream([{ messageStop: { stopReason: "end_turn" } }]));
    const executor = new BedrockExecutor();
    await executor.execute({
      model: "us.anthropic.claude-3-haiku-20240307-v1:0",
      body: { messages: [] },
      credentials: { apiKey: "x", providerSpecificData: { authMethod: "api_key", region: "us-east-1", inferenceProfilePrefix: "global." } },
      log: { warn: vi.fn() },
    });
    const [command] = sendMock.mock.calls[0];
    expect(command.input.modelId).toBe("us.anthropic.claude-3-haiku-20240307-v1:0");
  });
});

describe("BedrockExecutor — stream re-encoding", () => {
  beforeEach(() => { sendMock.mockReset(); clientConfigs.length = 0; });

  it("re-encodes each Converse event as a data: JSON line, terminated by [DONE]", async () => {
    sendMock.mockResolvedValue(fakeConverseStream([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: "hi" }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } },
    ]));
    const executor = new BedrockExecutor();
    const { response } = await executor.execute({
      model: "m",
      body: { messages: [] },
      credentials: { apiKey: "x", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } },
      log: { warn: vi.fn() },
    });

    const text = await readAll(response);
    const lines = text.split("\n\n").filter((l) => l.startsWith("data:"));
    expect(lines).toHaveLength(5); // 4 events + [DONE]
    expect(JSON.parse(lines[1].slice(5)).contentBlockDelta.delta.text).toBe("hi");
    expect(lines.at(-1)).toBe("data: [DONE]");
  });
});

// A mid-stream exception (internalServerException, throttlingException, etc.)
// arrives as a normal event through the async iterable, not a thrown
// rejection — confirmed from the SDK's ConverseStreamOutput union. Forwarding
// it raw leaves the generic SSE pipeline (open-sse/utils/stream.js) nothing
// to recognize as an error before translation, and the response translator
// has no error-shaped chunk to hand back either — the client gets an aborted
// connection with zero error content and no [DONE].
describe("BedrockExecutor — mid-stream exception events (skiptic review finding #1)", () => {
  beforeEach(() => { sendMock.mockReset(); clientConfigs.length = 0; });

  it("re-encodes an inline exception event as an {error:{message}} frame and stops iterating", async () => {
    const laterEvent = vi.fn();
    sendMock.mockResolvedValue({
      stream: (async function* () {
        yield { messageStart: { role: "assistant" } };
        yield { internalServerException: { message: "boom", name: "InternalServerException" } };
        laterEvent(); // must never run: the loop stops at the exception event
        yield { messageStop: { stopReason: "end_turn" } };
      })(),
    });
    const executor = new BedrockExecutor();
    const { response } = await executor.execute({
      model: "m",
      body: { messages: [] },
      credentials: { apiKey: "x", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } },
      log: { warn: vi.fn() },
    });

    const text = await readAll(response);
    const lines = text.split("\n\n").filter((l) => l.startsWith("data:"));
    expect(lines).toHaveLength(3); // messageStart + error frame + [DONE]
    const errorFrame = JSON.parse(lines[1].slice(5));
    expect(errorFrame).toEqual({ error: { message: "boom" } });
    expect(lines.at(-1)).toBe("data: [DONE]");
    expect(laterEvent).not.toHaveBeenCalled();
  });
});

describe("BedrockExecutor — error mapping (BUG #6)", () => {
  beforeEach(() => { sendMock.mockReset(); clientConfigs.length = 0; });

  it.each([
    ["ThrottlingException", 429],
    ["ValidationException", 400],
    ["AccessDeniedException", 403],
    ["ResourceNotFoundException", 404],
    ["ModelTimeoutException", 504],
    ["ServiceUnavailableException", 503],
  ])("maps a thrown %s to a %i Response instead of throwing out of execute()", async (name, expectedStatus) => {
    const err = Object.assign(new Error(`${name} boom`), { name });
    sendMock.mockRejectedValue(err);
    const executor = new BedrockExecutor();

    const { response } = await executor.execute({
      model: "m",
      body: { messages: [] },
      credentials: { apiKey: "x", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } },
      log: { warn: vi.fn() },
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(expectedStatus);
    const body = await response.json();
    expect(body.error.message).toContain("boom");
  });

  it("an unrecognized exception name falls back to 502 (bad gateway), not an uncaught throw", async () => {
    sendMock.mockRejectedValue(Object.assign(new Error("mystery"), { name: "SomeNewException" }));
    const executor = new BedrockExecutor();
    const { response } = await executor.execute({
      model: "m",
      body: { messages: [] },
      credentials: { apiKey: "x", providerSpecificData: { authMethod: "api_key", region: "us-east-1" } },
      log: { warn: vi.fn() },
    });
    expect(response.status).toBe(502);
  });
});

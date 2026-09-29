import { describe, it, expect } from "vitest";
import { resolveDetailSession, resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import { buildRequestDetail, extractRequestConfig } from "open-sse/handlers/chatCore/requestDetail.js";
import { detectClientTool } from "open-sse/utils/clientDetector.js";

const hashSessionId = (parts) => JSON.stringify(parts);
const CLAUDE_UUID = "6a4c1f2e-8b3d-4a7c-9e1f-0b2d3c4e5f60";
const OTHER_UUID = "11112222-3333-4444-5555-666677778888";

function detailSession(body, extra = {}) {
  return resolveDetailSession({ headers: {}, body, apiKey: "key-a", client: "claude", hashSessionId, ...extra });
}

describe("request detail session identity", () => {
  it("groups Claude Code turns across providers and connections", () => {
    const body = { metadata: { user_id: `user_account_session_${CLAUDE_UUID}` } };
    expect(detailSession(body)).toEqual(detailSession(body, { connectionId: "other", provider: "codex" }));
    expect(detailSession(body).client).toBe("claude");
  });

  it("separates Claude conversations and API keys", () => {
    const a = detailSession({ metadata: { user_id: `user_account_session_${CLAUDE_UUID}` } });
    const b = detailSession({ metadata: { user_id: `user_account_session_${OTHER_UUID}` } });
    const otherKey = detailSession({ metadata: { user_id: `user_account_session_${CLAUDE_UUID}` } }, { apiKey: "key-b" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(otherKey.id);
  });

  it("groups Codex and Hermes only with an explicit conversation id", () => {
    const codex = { conversation_id: "codex-conv-1" };
    const a = detailSession(codex, { client: "codex" });
    const b = detailSession(codex, { client: "codex", connectionId: "other" });
    expect(a.id).toBe(b.id);
    expect(detailSession({ prompt_cache_key: "shared-affinity" }, { client: "codex" })).toBeUndefined();
    const headers = { "x-session-id": "hermes-42" };
    expect(detailSession({}, { client: "hermes", headers }).id)
      .toBe(detailSession({}, { client: "hermes", headers, connectionId: "other" }).id);
  });

  it("groups Hermes turns by x-hermes-session-id", () => {
    const headers = { "x-hermes-session-id": "hermes-sess-1" };
    const client = detectClientTool(headers, {});
    expect(client).toBe("hermes");
    const a = detailSession({}, { client, headers });
    expect(a).toMatchObject({ client: "hermes" });
    expect(a.id).toBe(detailSession({}, { client, headers, connectionId: "other" }).id);
    expect(a.id).not.toBe(detailSession({}, { client, headers: { "x-hermes-session-id": "hermes-sess-2" } }).id);
  });

  it("never treats per-request, per-user or connection fallback as conversation", () => {
    expect(detailSession({ metadata: { user_id: "alice@example.com" } })).toBeUndefined();
    expect(detailSession({}, { headers: { "x-client-request-id": "req-1" } })).toBeUndefined();
    expect(detailSession({ messages: [{ role: "assistant", content: "x".repeat(80) }] })).toBeUndefined();
    expect(resolveSessionIdentity({ body: {}, connectionId: "account-1" }).sessionId).toBeTruthy();
  });

  it("stores no raw id when a hash is provided", () => {
    const raw = `user_account_session_${CLAUDE_UUID}`;
    const session = resolveDetailSession({ body: { metadata: { user_id: raw } }, apiKey: "key-a", client: "claude", hashSessionId: () => "opaque" });
    expect(buildRequestDetail({ provider: "p", model: "m", session }).session).toEqual({ id: "opaque", client: "claude" });
    expect(JSON.stringify(session)).not.toContain(raw);
  });

  it("retains Responses input and instructions in the client request", () => {
    const body = { model: "gpt", input: [{ role: "user", content: "prompt" }], instructions: "be concise", reasoning_effort: "high" };
    expect(extractRequestConfig(body, true)).toMatchObject({ input: body.input, instructions: "be concise", reasoning_effort: "high" });
    expect(extractRequestConfig(body, true).messages).toBeUndefined();
  });
});

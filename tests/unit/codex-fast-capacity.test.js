import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

// Delivers the body in fixed-size chunks, like a socket read would, so a peeking
// consumer that waits for a later marker must actually pull more chunks.
function streamFromChunks(text, chunkSize) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
}

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  // Codex opens a real turn with response.created, which echoes the whole request
  // (~145KB of tools + instructions). Waiting for output_text.delta meant draining
  // CODEX_SSE_PEEK_BYTES in full and holding the client's first byte until then.
  it("releases after the first event instead of draining the 256KB cap", async () => {
    const executor = new CodexExecutor();
    // The echo lands in response.created; the reasoning events that follow are what
    // the healthy-output markers do not recognise, so a peek keyed on
    // output_text.delta has to wait until output starts and hits the byte cap.
    const echo = "x".repeat(150 * 1024);
    const created = `event: response.created\ndata: {"type":"response.created","response":{"instructions":"${echo}"}}\n\n`;
    const reasoning = Array.from({ length: 60 }, (_, i) =>
      `event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"${"r".repeat(2048)}${i}"}\n\n`
    ).join("");
    const output = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
      "",
    ].join("\n");
    const full = created + reasoning + output;
    expect(full.length).toBeGreaterThan(256 * 1024);

    // 8KB chunks, like a socket read, so waiting for a later marker costs reads.
    const response = new Response(streamFromChunks(full, 8 * 1024), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.peekBytes).toBeLessThan(200 * 1024);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(full);
  });

  it("still catches an in-band error after a healthy first event", async () => {
    const executor = new CodexExecutor();
    const created = 'event: response.created\ndata: {"type":"response.created","response":{}}\n\n';
    const err = 'event: error\ndata: {"error":{"message":"server_is_overloaded"}}\n\n';
    const response = new Response(streamFromText(created + err), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("server_is_overloaded");
  });

  // Real turns open with response.created + response.in_progress; a capacity error
  // that follows them lands in a later socket read and must still rotate accounts.
  it("catches a capacity error delivered in a later chunk than the preamble", async () => {
    const executor = new CodexExecutor();
    const preamble = [
      'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress","response":{}}\n\n',
    ].join("");
    const err = 'event: error\ndata: {"error":{"message":"Selected model is at capacity. Please try a different model."}}\n\n';
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(preamble));
        controller.enqueue(encoder.encode(err));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
  });

  it("releases at the first event past the preamble without draining the turn", async () => {
    const executor = new CodexExecutor();
    const preamble = [
      'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress","response":{}}\n\n',
    ].join("");
    const item = 'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning"}}\n\n';
    const reasoning = `event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"${"r".repeat(64 * 1024)}"}\n\n`;
    const full = preamble + item + reasoning;
    const response = new Response(streamFromChunks(full, 1024), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.peekBytes).toBeLessThan(2048);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(full);
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});

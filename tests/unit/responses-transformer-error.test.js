import { describe, expect, it } from "vitest";

import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";

async function transform(input) {
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const reader = source.pipeThrough(createResponsesApiTransformStream()).getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  return output + decoder.decode();
}

describe("Responses transformer stream errors", () => {
  it("emits response.failed once without a success terminal", async () => {
    const output = await transform([
      `data: ${JSON.stringify({ id: "chatcmpl_test", choices: [{ index: 0, delta: { content: "partial" } }] })}`,
      "",
      `data: ${JSON.stringify({ error: { message: "socket ECONNRESET secret" } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));

    expect(output.match(/event: response.failed/g)).toHaveLength(1);
    expect(output).toContain('"status":"failed"');
    expect(output).toContain("Upstream provider stream failed");
    expect(output).not.toContain("ECONNRESET");
    expect(output).not.toContain("event: response.completed");
    expect(output).not.toContain("data: [DONE]");
  });
});

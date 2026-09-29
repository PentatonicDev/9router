import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

import { getExecutor } from "../../open-sse/executors/index.js";

const credentials = {
  apiKey: "test-key",
  connectionId: "connection-a",
  rawHeaders: {},
  runtimeTransport: { format: "openai", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
};
const body = { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "auto" };
const rejected = () => new Response(
  JSON.stringify({ error: { type: "invalid_request_error", message: "native reasoning control reasoning_effort is not supported" } }),
  { status: 400, headers: { "content-type": "application/json" } },
);
const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
const run = () => getExecutor("opencode-go").execute({ model: "glm-5.3-flash", body, stream: true, credentials });

beforeEach(() => fetchMock.mockReset());

describe("opencode-go reasoning_effort 400", () => {
  it("retries once without reasoning_effort", async () => {
    fetchMock.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(ok());
    const { response } = await run();
    expect(response.status).toBe(200);
    expect(sentBodies().map((b) => b.reasoning_effort)).toEqual(["auto", undefined]);
    expect(body.reasoning_effort).toBe("auto");
  });

  it("does not retry an unrelated 400", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"bad tools"}}', { status: 400 }));
    const { response } = await run();
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the second 400 instead of looping", async () => {
    fetchMock.mockResolvedValue(rejected());
    const { response } = await run();
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

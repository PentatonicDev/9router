import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cursorModels.js talks to agent.api5.cursor.sh over a raw node:http2 client
// (Node fetch/undici can't speak h2), not global fetch. Mock the http2 module
// itself so the GetUsableModels RPC never touches the network.
const cursorHttp2 = vi.hoisted(() => ({
  status: 200,
  body: new Uint8Array(),
  error: null,
  requests: [],
}));

vi.mock("http2", () => {
  class MiniEmitter {
    constructor() { this.listeners = {}; }
    on(event, cb) { (this.listeners[event] ||= []).push(cb); return this; }
    emit(event, ...args) { for (const cb of this.listeners[event] || []) cb(...args); }
  }

  return {
    default: {
      connect: () => {
        const client = new MiniEmitter();
        client.close = () => {};
        client.request = (headers) => {
          const req = new MiniEmitter();
          req.end = () => {
            cursorHttp2.requests.push(headers);
            queueMicrotask(() => {
              if (cursorHttp2.error) { req.emit("error", cursorHttp2.error); return; }
              req.emit("response", { ":status": cursorHttp2.status });
              req.emit("data", Buffer.from(cursorHttp2.body));
              req.emit("end");
            });
          };
          return req;
        };
        return client;
      },
    },
  };
});

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    cursorHttp2.status = 200;
    cursorHttp2.body = new Uint8Array();
    cursorHttp2.error = null;
    cursorHttp2.requests = [];
    clearCursorModelCache();
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    cursorHttp2.body = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    // Second call must come from cache — only one h2 request goes out.
    expect(cursorHttp2.requests).toHaveLength(1);
    expect(cursorHttp2.requests[0]).toEqual(
      expect.objectContaining({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/GetUsableModels",
        "content-type": "application/proto",
        accept: "application/proto",
      }),
    );
  });

  it("fails open when the Cursor catalog request fails", async () => {
    cursorHttp2.status = 403;

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});

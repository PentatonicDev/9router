import { getConsoleLogs, getConsoleEmitter, initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { isDistributed } from "@/lib/db/mode";
import { getInstanceId } from "@/lib/instanceId";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

export const dynamic = "force-dynamic";

initConsoleLogCapture();

// Poll period for the shared table. Cheap: an indexed `id > cursor` read that
// returns nothing when no instance logged.
const POLL_INTERVAL_MS = CONSOLE_LOG_CONFIG.pollIntervalMs;

export async function GET(request) {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, poll: null, cleanup: null };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    state.cleanup?.();
    if (state.keepalive) clearInterval(state.keepalive);
    if (state.poll) clearInterval(state.poll);
  };
  request.signal.addEventListener("abort", cleanup, { once: true });

  if (isDistributed()) {
    const { getConsoleLogsSince, getRecentConsoleLogs, getConsoleLogInstances } =
      await import("@/lib/db/repos/consoleLogsRepo.js");
    let cursor = 0;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload) => {
          if (state.closed) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            return true;
          } catch {
            cleanup();
            return false;
          }
        };

        try {
          // Open on the newest page (not the oldest), then follow forward by id.
          const recent = await getRecentConsoleLogs(CONSOLE_LOG_CONFIG.clientMaxLines);
          cursor = recent.length ? recent[recent.length - 1].id : 0;
          if (!send({
            type: "init",
            logs: recent.map((r) => r.line),
            entries: recent,
            instances: await getConsoleLogInstances(),
            selfInstance: getInstanceId(),
          })) return;
        } catch {
          send({ type: "init", logs: [], entries: [], instances: [], selfInstance: getInstanceId() });
        }

        const tick = async () => {
          if (state.closed) return;
          try {
            const rows = await getConsoleLogsSince(cursor);
            if (rows.length) {
              cursor = rows[rows.length - 1].id;
              send({ type: "entries", entries: rows });
            }
          } catch {
            // A transient read failure must not end the stream; next tick retries.
          } finally {
            // Schedule only after the read finishes: a slow database must not stack
            // overlapping polls for every open dashboard.
            if (!state.closed) state.poll = setTimeout(tick, POLL_INTERVAL_MS);
          }
        };
        state.poll = setTimeout(tick, POLL_INTERVAL_MS);

        state.keepalive = setInterval(() => {
          if (state.closed) return;
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, 25000);
      },
      cancel() {
        cleanup();
      },
    });

    state.cleanup = () => {};
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const emitter = getConsoleEmitter();

  const stream = new ReadableStream({
    start(controller) {
      const buffered = getConsoleLogs();
      if (buffered.length > 0) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "init", logs: buffered, selfInstance: getInstanceId() })}\n\n`));
      }

      const send = (line) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "line", line })}\n\n`));
        } catch {
          cleanup();
        }
      };

      const sendLines = (lines) => {
        if (state.closed || !Array.isArray(lines) || lines.length === 0) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "lines", lines })}\n\n`));
        } catch {
          cleanup();
        }
      };

      const sendClear = () => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "clear" })}\n\n`));
        } catch {
          cleanup();
        }
      };

      emitter.on("line", send);
      emitter.on("lines", sendLines);
      emitter.on("clear", sendClear);

      state.cleanup = () => {
        emitter.off("line", send);
        emitter.off("lines", sendLines);
        emitter.off("clear", sendClear);
      };

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { detectConsoleLogLevel } from "@/shared/utils/consoleLogLevel";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  return <span className={LOG_LEVEL_COLORS[detectConsoleLogLevel(line)] || LOG_LEVEL_COLORS.LOG}>{line}</span>;
}

// Stable per-pod hue so one instance stays one colour as lines interleave.
const INSTANCE_COLORS = [
  "text-sky-400", "text-fuchsia-400", "text-lime-400", "text-orange-400",
  "text-teal-400", "text-rose-400", "text-indigo-400", "text-amber-400",
];

function instanceColor(instanceId) {
  if (!instanceId) return "text-text-muted";
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) h = (h * 31 + instanceId.charCodeAt(i)) | 0;
  return INSTANCE_COLORS[Math.abs(h) % INSTANCE_COLORS.length];
}

function shortInstance(instanceId) {
  if (!instanceId) return "";
  // Pod names are long; the tail carries the replica ordinal that distinguishes them.
  return instanceId.length > 22 ? `…${instanceId.slice(-20)}` : instanceId;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [instances, setInstances] = useState([]);
  const [selected, setSelected] = useState("all");
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      const response = await fetch("/api/translator/console-logs", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Distributed mode has no cross-process EventEmitter. Clear this view from
      // the acknowledged DELETE; local mode also receives the SSE event, idempotently.
      setLogs([]);
      setInstances([]);
      setSelected("all");
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      const cap = (next) => {
        const max = CONSOLE_LOG_CONFIG.clientMaxLines;
        return next.length > max ? next.slice(-max) : next;
      };
      const merge = (prev, incoming) => cap([...prev, ...incoming]);

      if (msg.type === "init") {
        // Entries carry instanceId; plain logs are the local-mode shape.
        setLogs(cap(msg.entries || (msg.logs || []).map((line) => ({ line }))));
        if (msg.instances) setInstances(msg.instances);
      } else if (msg.type === "entries") {
        setLogs((prev) => merge(prev, msg.entries || []));
        setInstances((prev) => {
          const seen = new Set(prev.map((i) => i.instanceId));
          const added = (msg.entries || []).map((r) => r.instanceId).filter((id) => id && !seen.has(id));
          return added.length ? [...prev, ...added.map((instanceId) => ({ instanceId }))] : prev;
        });
      } else if (msg.type === "line") {
        setLogs((prev) => merge(prev, [{ line: msg.line }]));
      } else if (msg.type === "lines") {
        setLogs((prev) => merge(prev, (msg.lines || []).map((line) => ({ line }))));
      } else if (msg.type === "clear") {
        setLogs([]);
        setInstances([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, selected]);

  const visible = selected === "all" ? logs : logs.filter((l) => l.instanceId === selected);
  const multiInstance = instances.length > 1;

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {instances.length > 0 && (
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="text-xs rounded-md border border-border bg-bg px-2 py-1 font-mono"
                aria-label="Filter console logs by instance"
              >
                <option value="all">all pods ({instances.length})</option>
                {instances.map((i) => (
                  <option key={i.instanceId} value={i.instanceId}>{shortInstance(i.instanceId)}</option>
                ))}
              </select>
            )}
            <span className={`text-xs ${connected ? "text-green-500" : "text-red-500"}`}>
              {connected ? "live" : "disconnected"}
            </span>
          </div>
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
        <div
          ref={logRef}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {visible.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
          ) : (
            <div className="space-y-0.5">
              {visible.map((entry, i) => (
                <div key={entry.id ?? i} className="flex gap-2">
                  {multiInstance && (
                    <span
                      className={`shrink-0 ${instanceColor(entry.instanceId)}`}
                      title={entry.instanceId || "unknown instance"}
                    >
                      {shortInstance(entry.instanceId) || "-"}
                    </span>
                  )}
                  <span className="min-w-0 break-all">{colorLine(entry.line)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

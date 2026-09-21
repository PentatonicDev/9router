"use client";

import { useEffect, useState } from "react";
import { Card, Input, Button } from "@/shared/components";

// The SearXNG base URL lives in settings (admin-set, so internal Docker hosts are
// accepted past the SSRF guard). Blank keeps the SEARXNG_URL env default.
export default function SearxngInstanceCard({ onUrlChange }) {
  const [url, setUrl] = useState("");
  const [initial, setInitial] = useState(null);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState(null); // { ok: boolean, message: string }

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const loaded = data?.searxngUrl || "";
        setUrl(loaded);
        setInitial(loaded);
        onUrlChange?.(loaded);
      })
      .catch(() => {});
  }, [onUrlChange]);

  const dirty = initial !== null && url.trim() !== initial;

  const handleSave = async () => {
    setSaving(true);
    setProbe(null);
    const searxngUrl = url.trim();
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searxngUrl }),
      });
      if (res.ok) {
        setInitial(searxngUrl);
        setUrl(searxngUrl);
        onUrlChange?.(searxngUrl);
      }
    } catch { /* noop */ }
    setSaving(false);
  };

  const handleTest = async () => {
    setProbe({ ok: null, message: "Testing…" });
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "searxng" }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data?.valid !== false && data?.success !== false;
      setProbe(ok
        ? { ok: true, message: "Instance answered a JSON search." }
        : { ok: false, message: data?.error || "No JSON answer from the instance." });
    } catch (e) {
      setProbe({ ok: false, message: e.message });
    }
  };

  return (
    <Card padding="sm">
      <h2 className="text-base font-semibold mb-1">SearXNG instance</h2>
      <p className="text-xs text-text-muted mb-4">
        Used by /v1/search and by the web_search emulation inside chat when SearXNG is the source.
      </p>
      <div className="flex flex-col gap-3">
        <Input
          label="Base URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://searxng:8080 — leave blank to use SEARXNG_URL"
          hint="On the instance, add json to search.formats. Test runs a real JSON search from the gateway and names what blocks it (unreachable, 403 without json, 429 from the limiter). Private or Docker-internal hostnames are fine here: the admin sets this URL."
        />
        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="secondary" onClick={handleTest} disabled={saving || dirty}>
            Test
          </Button>
          {probe && (
            <span className={`text-xs ${probe.ok === false ? "text-error" : probe.ok ? "text-success" : "text-text-muted"}`}>
              {probe.message}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Card, Button, Input, Select, SegmentedControl } from "@/shared/components";
import ModelSelectModal from "@/shared/components/ModelSelectModal";

// Three states in one field, not an `enabled` flag plus a mode string: "shadow"
// is the only way to measure what the router would have done without letting it
// act, which is the baseline the savings claim has to be measured against.
const MODES = [
  { value: "off", label: "Off", desc: "Never asks jev. Routing is exactly as it was." },
  { value: "shadow", label: "Shadow", desc: "Asks jev and logs the verdict, applies nothing — the baseline you compare against." },
  { value: "enforce", label: "Enforce", desc: "Asks jev and applies the verdict." },
];

const TOOL_MODES = [
  { value: "hint", label: "hint (default)" },
  { value: "forced", label: "forced" },
  { value: "none", label: "none" },
];

export default function DecisionRouterCard({ provider }) {
  const [config, setConfig] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [probe, setProbe] = useState(null);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.decisionRouter) setConfig(data.decisionRouter); })
      .catch(() => {});
    fetch("/api/providers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setActiveProviders(data?.connections || []))
      .catch(() => {});
  }, []);

  if (!config) return null;

  const defaults = provider?.decisionConfig || {};
  const models = config.models || [];
  const briefs = config.briefs || {};
  const activeMode = MODES.find((m) => m.value === config.mode) || MODES[0];

  // Optimistic autosave, same shape as the Vision Adapter in the combos page:
  // state first, fire-and-forget PATCH after, no Save button.
  const patch = (next) => {
    setConfig(next);
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionRouter: next }),
    }).catch(() => {});
  };
  const set = (key, value) => patch({ ...config, [key]: value });

  const valueOf = (m) => m?.value || m?.name || m;
  const addModel = (m) => {
    const value = valueOf(m);
    if (!value || models.includes(value)) return;
    patch({ ...config, models: [...models, value] });
  };
  const removeModel = (m) => patch({ ...config, models: models.filter((v) => v !== valueOf(m)) });
  const setBrief = (value, text) => patch({ ...config, briefs: { ...briefs, [value]: text } });

  const handleTest = async () => {
    setProbe({ ok: null, message: "Testing…" });
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider?.id || "jev" }),
      });
      const data = await res.json().catch(() => ({}));
      setProbe(res.ok && data?.valid
        ? { ok: true, message: "The decision endpoint answered." }
        : { ok: false, message: data?.error || `Validation failed (HTTP ${res.status})` });
    } catch (e) {
      setProbe({ ok: false, message: e.message });
    }
  };

  return (
    <Card padding="sm">
      <h2 className="text-base font-semibold mb-1">Decision router</h2>
      <p className="text-xs text-text-muted mb-4">
        jev picks which model of a combo serves a turn, and which tool the model should call.
        It only ever routes to the models listed below.
      </p>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <SegmentedControl options={MODES} value={config.mode} onChange={(v) => set("mode", v)} size="sm" />
          <p className="text-xs text-text-muted">{activeMode.desc}</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Models and combos</p>
            <Button icon="add" variant="ghost" size="sm" onClick={() => setShowModelSelect(true)}>
              Add
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Each model needs its brief below — the text that says what it is FOR. Measured on the
            same pool: criteria built from price and capability flags decided 0/4 correctly, curated
            briefs decided 5/5. A model without a brief falls back to the repo table.
          </p>
          <div className="flex flex-col gap-2">
            {models.length === 0 ? (
              <span className="text-xs text-text-muted italic">No models — nothing routes.</span>
            ) : models.map((value) => {
              const isCombo = !value.includes("/");
              const open = expanded === value;
              const brief = briefs[value] || "";
              return (
                <div key={value} className="flex flex-col gap-1.5">
                  <div className="inline-flex w-fit items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/5">
                    <button
                      type="button"
                      onClick={() => !isCombo && setExpanded(open ? null : value)}
                      className="inline-flex items-center gap-1 font-mono text-xs text-text-muted hover:text-primary"
                      title={isCombo ? "Combo (rerouted by the decision router)" : "Model"}
                    >
                      <span className="material-symbols-outlined text-[12px]">{isCombo ? "layers" : "smart_toy"}</span>
                      <span>{value}</span>
                      {!isCombo && (
                        <span className={`material-symbols-outlined text-[12px] ${brief ? "text-primary" : ""}`}>
                          {open ? "expand_less" : "expand_more"}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeModel(value)}
                      className="leading-none text-text-muted hover:text-red-500"
                      aria-label={`Remove ${value}`}
                    >
                      <span className="material-symbols-outlined text-[12px]">close</span>
                    </button>
                  </div>
                  {open && !isCombo && (
                    <textarea
                      value={brief}
                      onChange={(e) => setBrief(value, e.target.value)}
                      rows={3}
                      placeholder="Using the default brief from the repo. Write one here to override it — e.g. “architectural decisions, root-cause debugging of intermittent production bugs”."
                      className="w-full rounded-[10px] border border-transparent bg-surface-2 px-3 py-2 text-xs text-text-main placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Tool mode"
            options={TOOL_MODES}
            value={config.toolMode}
            onChange={(e) => set("toolMode", e.target.value)}
            hint="How a tool verdict is applied. Only `forced` differs today: the text hint is allowed for every value but it — `hint` and `none` are still treated alike."
          />
          <Input
            label="Min confidence"
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={config.minConfidence}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set("minConfidence", n); }}
            hint={`Below this the verdict is discarded. Default ${defaults.minConfidence ?? 0.7}.`}
          />
          <Input
            label="Switch confidence"
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={config.switchConfidence}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set("switchConfidence", n); }}
            hint={`At or above this the model switches on the same turn. Between the two bounds it needs two agreeing verdicts. Default ${defaults.switchConfidence ?? 0.85}.`}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Button size="sm" variant="secondary" onClick={handleTest}>Test</Button>
          {probe && (
            <span className={`text-xs ${probe.ok === false ? "text-error" : probe.ok ? "text-success" : "text-text-muted"}`}>
              {probe.message}
            </span>
          )}
        </div>
      </div>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={addModel}
          onDeselect={removeModel}
          activeProviders={activeProviders}
          title="Add Model or Combo"
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </Card>
  );
}

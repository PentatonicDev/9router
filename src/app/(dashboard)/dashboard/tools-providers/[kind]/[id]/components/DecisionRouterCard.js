"use client";

import { useEffect, useState } from "react";
import { Card, Button, Input, Select, SegmentedControl, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { getProvidersByKind } from "@/shared/constants/providers";
import ModelSelectModal from "@/shared/components/ModelSelectModal";

// Three states in one field, not an `enabled` flag plus a mode string: "shadow"
// is the only way to measure what the router would have done without letting it
// act, which is the baseline the savings claim has to be measured against.
const MODES = [
  { value: "off", label: "Off", desc: "Never asks the decision model. Routing is exactly as it was." },
  { value: "shadow", label: "Shadow", desc: "Asks and logs the verdict, applies nothing — the baseline you compare against." },
  { value: "enforce", label: "Enforce", desc: "Asks and applies the verdict." },
];

// How much evidence a verdict needs before it acts. The bands come from measured
// confidence: bad criteria and vague tasks land at 0.43–0.57, clear ones at
// 0.96–1.00. A preset picks where the two thresholds sit; nobody has to reason in
// probabilities to choose one.
const PRESETS = [
  {
    value: "cautious",
    label: "Cautious",
    desc: "Acts only on near-certain verdicts. Fewest switches, lowest risk of a wrong route.",
    minConfidence: 0.8,
    switchConfidence: 0.9,
  },
  {
    value: "balanced",
    label: "Balanced",
    desc: "Acts on clear verdicts. The measured default.",
    minConfidence: 0.7,
    switchConfidence: 0.85,
  },
  {
    value: "eager",
    label: "Eager",
    desc: "Also acts on weaker verdicts, in the ambiguous band. More switches, more chances to route wrong.",
    minConfidence: 0.6,
    switchConfidence: 0.75,
  },
];

function presetOf(config) {
  return PRESETS.find(
    (p) => p.minConfidence === config.minConfidence && p.switchConfidence === config.switchConfidence,
  )?.value || "custom";
}

// Narrowest first: each value is a strict superset of the one above it, so the
// list reads as the ceiling it is rather than as three unrelated options.
// `none` is deliberately not offered. Measured: pinning tool_choice to "none" made
// every coding task fail — the model writes its tool call as text the client cannot
// run, so the work silently never happens (0/3, in 2.9s each, fixture untouched).
const TOOL_MODES = [
  { value: "off", label: "Off — models only, no tool routing" },
  { value: "hint", label: "Hint — suggest the tool, never pin it" },
  { value: "forced", label: "Forced — also allow pinning a tool" },
];

export default function DecisionRouterCard({ provider }) {
  const [config, setConfig] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [advanced, setAdvanced] = useState(false);
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
  const activeMode = MODES.find((m) => m.value === config.mode) || MODES[0];
  const activePreset = presetOf(config);

  const gateways = getProvidersByKind("decision");
  const gateway = gateways.find((g) => g.id === config.provider || g.alias === config.provider) || null;
  const gatewayId = gateway?.id || config.provider;
  const conn = activeProviders.find((c) => c.provider === gatewayId);
  const connBroken = conn?.testStatus === "unavailable";

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

  const setPreset = (value) => {
    const preset = PRESETS.find((p) => p.value === value);
    if (!preset) return;
    patch({ ...config, minConfidence: preset.minConfidence, switchConfidence: preset.switchConfidence });
  };

  // The new gateway's default model comes along only while the current model is
  // still the old gateway's default. A model the operator typed is their pick,
  // not a value to overwrite.
  const setGateway = (id) => {
    const next = gateways.find((g) => g.id === id);
    const untouched = !gateway?.decisionConfig?.defaultModel
      || config.model === gateway.decisionConfig.defaultModel;
    patch({
      ...config,
      provider: id,
      model: untouched ? (next?.decisionConfig?.defaultModel || config.model) : config.model,
    });
  };

  const valueOf = (m) => m?.value || m?.name || m;
  const addModel = (m) => {
    const value = valueOf(m);
    if (!value || models.includes(value)) return;
    patch({ ...config, models: [...models, value] });
  };
  const removeModel = (m) => patch({ ...config, models: models.filter((v) => v !== valueOf(m)) });

  const handleTest = async () => {
    setProbe({ ok: null, message: translate("Testing…") });
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: gatewayId }),
      });
      const data = await res.json().catch(() => ({}));
      setProbe(res.ok && data?.valid
        ? { ok: true, message: translate("The decision endpoint answered.") }
        : { ok: false, message: data?.error || translate("Validation failed") });
    } catch (e) {
      setProbe({ ok: false, message: e.message });
    }
  };

  return (
    <Card padding="sm">
      <h2 className="text-base font-semibold mb-1">{translate("Decision router")}</h2>
      <p className="text-xs text-text-muted mb-4">
        {translate("Picks which model of a combo serves each turn. Only routes to the models listed below.")}
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <SegmentedControl options={MODES} value={config.mode} onChange={(v) => set("mode", v)} size="sm" />
          <p className="text-xs text-text-muted">{translate(activeMode.desc)}</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">{translate("Models and combos")}</p>
            <Button icon="add" variant="ghost" size="sm" onClick={() => setShowModelSelect(true)}>
              {translate("Add")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {models.length === 0 ? (
              <span className="text-xs text-text-muted italic">{translate("Nothing selected — routing is off.")}</span>
            ) : models.map((value) => (
              <span key={value} className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/5">
                <span className="material-symbols-outlined text-[12px] text-text-muted">
                  {value.includes("/") ? "smart_toy" : "layers"}
                </span>
                <span className="font-mono text-xs text-text-muted">{value}</span>
                <button
                  type="button"
                  onClick={() => removeModel(value)}
                  className="leading-none text-text-muted hover:text-red-500"
                  aria-label={`${translate("Remove")} ${value}`}
                >
                  <span className="material-symbols-outlined text-[12px]">close</span>
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{translate("How decisive")}</p>
          <SegmentedControl
            options={PRESETS.map((p) => ({ value: p.value, label: translate(p.label) }))}
            value={activePreset === "custom" ? null : activePreset}
            onChange={setPreset}
            size="sm"
          />
          <p className="text-xs text-text-muted">
            {activePreset === "custom"
              ? translate("Custom thresholds — calibrated in Advanced.")
              : translate(PRESETS.find((p) => p.value === activePreset).desc)}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            className="inline-flex w-fit items-center gap-1 text-xs text-text-muted hover:text-primary"
          >
            <span className="material-symbols-outlined text-[16px]">
              {advanced ? "expand_less" : "expand_more"}
            </span>
            {translate("Advanced")}
          </button>

          {advanced && (
            <div className="flex flex-col gap-4 rounded-lg border border-black/5 p-3 dark:border-white/5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  label={translate("Gateway")}
                  options={gateways.map((g) => ({ value: g.id, label: g.name }))}
                  value={gatewayId}
                  onChange={(e) => setGateway(e.target.value)}
                  hint={translate("Serves the decision model, and lends it its credential.")}
                />
                <Input
                  label={translate("Model")}
                  value={config.model ?? ""}
                  onChange={(e) => set("model", e.target.value)}
                  placeholder={defaults.defaultModel || ""}
                  hint={translate("Any System-1 model works; swap it by editing this field.")}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  label={translate("Tool routing")}
                  options={TOOL_MODES.map((m) => ({ value: m.value, label: translate(m.label) }))}
                  value={config.toolMode}
                  onChange={(e) => set("toolMode", e.target.value)}
                  hint={translate("How far a tool verdict may go. A verdict above the ceiling becomes a hint, never a dropped one.")}
                />
                <div className="flex flex-col gap-3">
                  <Input
                    label={translate("Min confidence")}
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={config.minConfidence}
                    onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set("minConfidence", n); }}
                    hint={translate("Below this the verdict is discarded.")}
                  />
                  <Input
                    label={translate("Switch confidence")}
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={config.switchConfidence}
                    onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set("switchConfidence", n); }}
                    hint={translate("At or above this it switches this turn; below, it needs two agreeing verdicts.")}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{translate("Cap reasoning on mechanical turns")}</p>
                  <Toggle size="sm" checked={config.effort === true} onChange={() => set("effort", config.effort !== true)} />
                </div>
                <p className="text-xs text-text-muted">
                  {translate("The same verdict that picks the model also caps the reasoning budget; a hard turn is left as the client asked.")}
                </p>
              </div>

              <div className="flex flex-col gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/5">{gateway?.name || gatewayId}</span>
                  <span className="text-text-muted">{translate("borrows its own chat connection")}</span>
                  {conn ? (
                    <span className={connBroken ? "text-amber-600 dark:text-amber-500" : "text-text-muted"}>
                      — {conn.name || translate("connection")}
                      {connBroken ? translate(" (marked unavailable by the last health check)") : ""}
                    </span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-500">
                      — {translate("no connection yet, so the decision model cannot be asked")}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <Button size="sm" variant="secondary" onClick={handleTest}>{translate("Test")}</Button>
                {probe && (
                  <span className={`text-xs ${probe.ok === false ? "text-error" : probe.ok ? "text-success" : "text-text-muted"}`}>
                    {probe.message}
                  </span>
                )}
              </div>
            </div>
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
          title={translate("Add Model or Combo")}
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </Card>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Button, SegmentedControl } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { getProvidersByKind } from "@/shared/constants/providers";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { DECISION_PRESETS } from "open-sse/decision/presets.js";

const MODES = [
  { value: "off", label: "Off", desc: "Never asks the decision model. Routing is exactly as it was." },
  { value: "shadow", label: "Shadow", desc: "Asks and logs the verdict, applies nothing — the baseline you compare against." },
  { value: "enforce", label: "Enforce", desc: "Asks and applies the verdict." },
];

const PRESETS = Object.entries(DECISION_PRESETS).map(([value, settings]) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
  ...settings,
}));

export default function DecisionRouterCard() {
  const [config, setConfig] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const patchQueue = useRef(Promise.resolve());

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.decisionRouter) setConfig({ ...data.decisionRouter, preset: data.decisionRouter.preset || "balanced" });
        setComboStrategies(data?.comboStrategies || {});
      })
      .catch(() => {});
    fetch("/api/providers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setActiveProviders(data?.connections || []))
      .catch(() => {});
  }, []);

  if (!config) return null;

  // The combos that opted in, read from the setting the runtime actually uses
  // (chat.js reads strategy === "auto"). An allowlist on this card was editable,
  // saved, and consumed by nothing.
  const autoCombos = Object.entries(comboStrategies)
    .filter(([, v]) => v?.fallbackStrategy === "auto")
    .map(([name]) => name);
  const activeMode = MODES.find((m) => m.value === config.mode) || MODES[0];
  const activePreset = PRESETS.find((preset) => preset.value === config.preset)?.value || "balanced";
  const activePresetLabel = PRESETS.find((preset) => preset.value === activePreset)?.label;

  const gateways = getProvidersByKind("systemone");
  const gateway = gateways.find((g) => g.id === config.provider || g.alias === config.provider) || null;
  const gatewayId = gateway?.id || config.provider;
  const conn = activeProviders.find((c) => c.provider === gatewayId);
  const connectedGateways = gateways.filter((item) => activeProviders.some((connection) => connection.provider === item.id));
  const patch = (next) => {
    setConfig(next);
    patchQueue.current = patchQueue.current
      .catch(() => {})
      .then(() => fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionRouter: next }),
      }));
  };
  const set = (key, value) => patch({ ...config, [key]: value });
  const setPreset = (value) => {
    const preset = DECISION_PRESETS[value];
    if (preset) patch({ ...config, ...preset, preset: value });
  };
  const selectModel = (model) => {
    const provider = gateways
      .filter((item) => model.value.startsWith(`${item.alias}/`) || model.value.startsWith(`${item.id}/`))
      .sort((a, b) => Math.max(b.alias?.length || 0, b.id.length) - Math.max(a.alias?.length || 0, a.id.length))[0];
    const providerId = provider?.id || gatewayId;
    const prefix = model.value.startsWith(`${provider?.alias}/`) ? provider.alias : providerId;
    const modelId = model.value.startsWith(`${prefix}/`) ? model.value.slice(prefix.length + 1) : model.id;
    patch({ ...config, provider: providerId, model: modelId });
    setModelPickerOpen(false);
  };

  return (
    <Card padding="sm">
      <h2 className="text-base font-semibold mb-1">{translate("Decision router")}</h2>
      <p className="text-xs text-text-muted mb-4">
        {translate("Picks which model of a combo serves each turn. Only routes to the models listed below.")}
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{translate("Decision model")}</p>
            <p className="text-xs text-text-muted">
              {config.model || gateway?.systemoneConfig?.defaultModel || translate("No model selected")}
              {conn?.testStatus === "unavailable" ? translate(" · connection unavailable") : !conn ? translate(" · no connection") : ""}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setModelPickerOpen(true)}>{translate("Select model")}</Button>
        </div>

        <div className="flex flex-col gap-2">
          <SegmentedControl options={MODES} value={config.mode} onChange={(v) => set("mode", v)} size="sm" />
          <p className="text-xs text-text-muted">{translate(activeMode.desc)}</p>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{translate("Combos routed")}</p>
          {autoCombos.length === 0 ? (
            <span className="text-xs text-text-muted italic">
              {translate('None — set a combo\'s strategy to "auto" to route it.')}
            </span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {autoCombos.map((name) => (
                <a
                  key={name}
                  href="/dashboard/combos"
                  className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
                >
                  <span className="material-symbols-outlined text-[12px] text-text-muted">layers</span>
                  <span className="font-mono text-xs text-text-muted">{name}</span>
                </a>
              ))}
            </div>
          )}
        </div>


        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{translate("How decisive")}</p>
          <SegmentedControl
            options={PRESETS.map((preset) => ({ value: preset.value, label: translate(preset.label) }))}
            value={activePreset}
            onChange={setPreset}
            size="sm"
          />
            <p className="text-xs text-text-muted">
            {translate(activePresetLabel)} — {activePreset === "cautious" ? translate("Acts only on near-certain verdicts.") : activePreset === "eager" ? translate("Also acts on weaker verdicts.") : translate("Acts on clear verdicts.")}
            {PRESETS.find((preset) => preset.value === activePreset)?.toolMode === "off" ? translate(" Tools off.") : PRESETS.find((preset) => preset.value === activePreset)?.toolMode === "forced" ? translate(" Tool pinning allowed.") : translate(" Tool suggestions enabled.")}
            {PRESETS.find((preset) => preset.value === activePreset)?.effort ? translate(" Reasoning cap enabled.") : translate(" Reasoning unchanged.")}
          </p>
        </div>
      </div>
      <ModelSelectModal
        isOpen={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        onSelect={selectModel}
        selectedModel={config.model ? `${gateway?.alias || gatewayId}/${config.model}` : ""}
        activeProviders={activeProviders.filter((connection) => connectedGateways.some((item) => item.id === connection.provider))}
        title={translate("Select decision model")}
        kindFilter="systemone"
        singleSelect
      />
    </Card>
  );
}

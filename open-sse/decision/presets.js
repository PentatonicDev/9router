export const DECISION_PRESETS = {
  cautious: { minStrength: 0.6, switchStrength: 0.85, minConfidence: 0.9, toolMode: "off", effort: false },
  balanced: { minStrength: 0.35, switchStrength: 0.6, minConfidence: 0.7, toolMode: "hint", effort: true },
  eager: { minStrength: 0.3, switchStrength: 0.45, minConfidence: 0.6, toolMode: "forced", effort: true },
};

export function decisionPreset(value) {
  return Object.hasOwn(DECISION_PRESETS, value) ? value : "balanced";
}

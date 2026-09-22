"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Input, Modal, Toggle, ConfirmModal, Select, SegmentedControl } from "@/shared/components";
import { getProvidersByKind } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

// Defined at module level: components created inside a render are new types on
// every pass, which remounts them and loses focus/state.
function DefaultBadge({ keys, scoped, inherited }) {
  if (!scoped || !keys.every((k) => inherited.includes(k))) return null;
  return (
    <span
      className="ml-2 rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-medium text-text-muted align-middle dark:bg-white/10"
      title="Using the admin's default. Changing it here creates your own setting."
    >
      default
    </span>
  );
}

function ResetLink({ keys, scoped, inherited, onReset }) {
  if (!scoped || keys.every((k) => inherited.includes(k))) return null;
  return (
    <button
      type="button"
      onClick={() => onReset(keys)}
      className="ml-2 align-middle text-[10px] text-text-muted underline transition-colors hover:text-primary"
      title="Drop your setting and follow the admin's default again"
    >
      use default
    </button>
  );
}

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [headroomUrl, setHeadroomUrl] = useState("http://localhost:8787");
  const [headroomTimeoutMs, setHeadroomTimeoutMs] = useState(3000);
  const [headroomCompressUserMessages, setHeadroomCompressUserMessages] = useState(false);
  const [headroomPerApiKeyProject, setHeadroomPerApiKeyProject] = useState(false);
  // Which keys still come from the admin's global config, and whether this user
  // has a scope of their own at all.
  const [inherited, setInherited] = useState([]);
  const [scoped, setScoped] = useState(false);
  // Headroom is infrastructure: installing and starting it is the admin's job.
  const [isAdmin, setIsAdmin] = useState(true);
  const [headroomStatus, setHeadroomStatus] = useState({
    installed: false,
    running: false,
    python: null,
    loading: true,
  });
  const [showHeadroomInstallModal, setShowHeadroomInstallModal] =
    useState(false);
  const [headroomActionLoading, setHeadroomActionLoading] = useState(false);
  const [headroomActionError, setHeadroomActionError] = useState("");
  const [headroomExtras, setHeadroomExtras] = useState({
    version: null,
    extras: { code: false, ml: false },
    available: ["code", "ml"],
    loading: false,
  });
  const [pendingExtras, setPendingExtras] = useState([]);
  const [extrasActionLoading, setExtrasActionLoading] = useState(false);
  const [extrasActionError, setExtrasActionError] = useState("");
  const [removingExtra, setRemovingExtra] = useState(null);
  const [installLog, setInstallLog] = useState("");
  const [extrasConfirm, setExtrasConfirm] = useState(null);
  const [codeAware, setCodeAware] = useState(false);
  const [kompress, setKompress] = useState(true);
  const [restartingProxy, setRestartingProxy] = useState(false);
  const logPollRef = useRef(null);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [pxpipeEnabled, setPxpipeEnabled] = useState(false);
  const [pxpipeMinChars, setPxpipeMinChars] = useState(25000);
  const [pxpipeStatus, setPxpipeStatus] = useState({
    installed: false,
    installing: false,
    running: false,
    version: null,
    loading: true,
  });
  const [pxpipeHealth, setPxpipeHealth] = useState(null);
  const [showPxpipeModal, setShowPxpipeModal] = useState(false);
  const [pxpipeActionLoading, setPxpipeActionLoading] = useState(false);
  const [pxpipeActionError, setPxpipeActionError] = useState("");
  const [locale, setLocale] = useState("en");

  // Decision Router state
  const [drConfig, setDrConfig] = useState(null);
  const [drExpanded, setDrExpanded] = useState(false);
  const [drConnections, setDrConnections] = useState([]);
  const [drComboStrategies, setDrComboStrategies] = useState({});
  const [drProbe, setDrProbe] = useState(null);

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel);
    if (current?.wenyan && !isWenyanLocale) {
      setCavemanLevel("ultra");
      patchSetting({ cavemanLevel: "ultra" });
    }
  }, [isWenyanLocale, cavemanLevel]);

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      // Saving turns an inherited value into the user's own, so refresh which
      // keys are still the admin's rather than leaving a stale badge behind.
      // Unconditional: reading `scoped` here would make this reactive, and the
      // response carries the field either way.
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setInherited(data.tokenSaverInherited || []);
      }
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  // Back to the admin's value: null clears the override server-side.
  const resetToDefault = (keys) => patchSetting(Object.fromEntries(keys.map((k) => [k, null])));



  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleHeadroomEnabled = (value) => {
    const nextUrl = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(nextUrl);
    setHeadroomEnabled(value);
    patchSetting({ headroomEnabled: value, headroomUrl: nextUrl });
  };

  const handleHeadroomUrlBlur = async () => {
    const next = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(next);
    await patchSetting({ headroomUrl: next });
    refreshHeadroomStatus();
  };

  const refreshHeadroomStatus = useCallback(async () => {
    setHeadroomStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/headroom/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setHeadroomStatus({ ...data, loading: false });
      if (!data?.installed) {
        setHeadroomExtras({
          version: null,
          extras: { code: false, ml: false },
          available: ["code", "ml"],
          loading: false,
        });
        setPendingExtras([]);
        return;
      }
      try {
        const er = await fetch("/api/headroom/extras", {
          headers: { "Cache-Control": "no-store" },
        });
        if (!er.ok) throw new Error("extras status failed");
        const ed = await er.json();
        setHeadroomExtras((s) => ({
          ...s,
          version: ed.version ?? null,
          extras: ed.extras || { code: false, ml: false },
          available: ed.available || ["code", "ml"],
          loading: false,
        }));
        setPendingExtras([]);
      } catch {
        setHeadroomExtras({
          version: null,
          extras: { code: false, ml: false },
          available: ["code", "ml"],
          loading: false,
        });
        setPendingExtras([]);
      }
    } catch {
      setHeadroomStatus({
        installed: false,
        running: false,
        python: null,
        loading: false,
      });
      setHeadroomExtras({
        version: null,
        extras: { code: false, ml: false },
        available: ["code", "ml"],
        loading: false,
      });
      setPendingExtras([]);
    }
  }, []);

  const handleHeadroomStart = useCallback(async () => {
    setHeadroomActionError("");
    setHeadroomActionLoading(true);
    try {
      const res = await fetch("/api/headroom/start", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start proxy");
      await refreshHeadroomStatus();
    } catch (e) {
      setHeadroomActionError(e.message);
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const handleHeadroomStop = useCallback(async () => {
    setHeadroomActionLoading(true);
    try {
      await fetch("/api/headroom/stop", { method: "POST" });
      await refreshHeadroomStatus();
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const togglePendingExtra = (extra) => {
    setPendingExtras((cur) =>
      cur.includes(extra) ? cur.filter((e) => e !== extra) : [...cur, extra]
    );
  };

  // Poll the install log tail while a pip install/uninstall is running.
  const startLogPolling = useCallback(() => {
    setInstallLog("");
    if (logPollRef.current) clearInterval(logPollRef.current);
    const tick = async () => {
      try {
        const r = await fetch("/api/headroom/extras?log=1", {
          headers: { "Cache-Control": "no-store" },
        });
        const d = await r.json().catch(() => ({}));
        if (typeof d.log === "string") setInstallLog(d.log);
      } catch { /* ignore transient poll errors */ }
    };
    tick();
    logPollRef.current = setInterval(tick, 1500);
  }, []);

  const stopLogPolling = useCallback(() => {
    if (logPollRef.current) {
      clearInterval(logPollRef.current);
      logPollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopLogPolling(), [stopLogPolling]);

  const installExtrasConfirmed = useCallback(async () => {
    if (pendingExtras.length === 0) return;
    setExtrasActionLoading(true);
    setExtrasActionError("");
    startLogPolling();
    try {
      const res = await fetch("/api/headroom/extras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extras: pendingExtras }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Install failed");
      setHeadroomExtras((s) => ({
        ...s,
        version: data.version ?? s.version,
        extras: data.extras || s.extras,
      }));
      setPendingExtras([]);
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      stopLogPolling();
      setExtrasActionLoading(false);
    }
  }, [pendingExtras, startLogPolling, stopLogPolling]);

  const removeExtraConfirmed = useCallback(async (extra) => {
    setRemovingExtra(extra);
    setExtrasActionError("");
    startLogPolling();
    try {
      const res = await fetch("/api/headroom/extras", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extras: [extra] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Remove failed");
      setHeadroomExtras((s) => ({
        ...s,
        version: data.version ?? s.version,
        extras: data.extras || s.extras,
      }));
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      stopLogPolling();
      setRemovingExtra(null);
    }
  }, [startLogPolling, stopLogPolling]);

  const handleInstallExtras = useCallback(() => {
    if (pendingExtras.length === 0) return;
    // Warn about the heavy ~1GB torch download before installing [ml].
    if (pendingExtras.includes("ml")) {
      setExtrasConfirm({
        title: "Install [ml]",
        message: "[ml] downloads ~1 GB (torch + huggingface-hub). Continue?",
        confirmText: "Install",
        variant: "primary",
        onConfirm: installExtrasConfirmed,
      });
      return;
    }
    installExtrasConfirmed();
  }, [pendingExtras, installExtrasConfirmed]);

  const handleRemoveExtra = useCallback((extra) => {
    setExtrasConfirm({
      title: `Remove [${extra}]`,
      message: `Remove [${extra}] and its packages?`,
      confirmText: "Remove",
      variant: "danger",
      onConfirm: () => removeExtraConfirmed(extra),
    });
  }, [removeExtraConfirmed]);

  // Toggle an extra's active state (persist setting), then restart the proxy so
  // the new --code-aware / --disable-kompress flags take effect.
  const toggleExtraActive = useCallback(async (extra, value) => {
    setExtrasActionError("");
    if (extra === "code") setCodeAware(value);
    if (extra === "ml") setKompress(value);
    const key = extra === "code" ? "headroomCodeAware" : "headroomKompress";
    await patchSetting({ [key]: value });
    if (!headroomStatus.running) return;
    setRestartingProxy(true);
    try {
      const res = await fetch("/api/headroom/restart", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restart failed");
      await refreshHeadroomStatus();
    } catch (e) {
      setExtrasActionError(e.message);
    } finally {
      setRestartingProxy(false);
    }
  }, [headroomStatus.running, refreshHeadroomStatus]);

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  const refreshPxpipeStatus = useCallback(async () => {
    setPxpipeStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/pxpipe/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setPxpipeStatus({ ...data, loading: false });
      if (typeof data.minChars === "number") setPxpipeMinChars(data.minChars);
    } catch {
      setPxpipeStatus({ installed: false, installing: false, running: false, version: null, loading: false });
    }
  }, []);

  const runPxpipeHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/pxpipe/health", { method: "POST" });
      setPxpipeHealth(await res.json());
    } catch (e) {
      setPxpipeHealth({ healthy: false, checks: [], error: e.message });
    }
  }, []);

  const pxpipeAction = useCallback(
    async (endpoint) => {
      setPxpipeActionError("");
      setPxpipeActionLoading(true);
      try {
        const res = await fetch(`/api/pxpipe/${endpoint}`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `PXPIPE ${endpoint} failed`);
        await refreshPxpipeStatus();
        await runPxpipeHealth();
      } catch (e) {
        setPxpipeActionError(e.message);
      } finally {
        setPxpipeActionLoading(false);
      }
    },
    [refreshPxpipeStatus, runPxpipeHealth]
  );

  const handlePxpipeEnabled = (value) => {
    setPxpipeEnabled(value);
    patchSetting({ pxpipeEnabled: value });
  };

  const handlePxpipeMinCharsBlur = () => {
    const next = Math.max(0, Number(pxpipeMinChars) || 25000);
    setPxpipeMinChars(next);
    patchSetting({ pxpipeMinChars: next });
  };

  const handleHeadroomTimeoutBlur = () => {
    const raw = Math.round(Number(headroomTimeoutMs));
    const next = Number.isFinite(raw) && raw > 0 ? raw : 3000;
    setHeadroomTimeoutMs(next);
    patchSetting({ headroomTimeoutMs: next });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setHeadroomEnabled(!!data.headroomEnabled);
          setHeadroomUrl(data.headroomUrl || "http://localhost:8787");
          if (typeof data.headroomTimeoutMs === "number") setHeadroomTimeoutMs(data.headroomTimeoutMs);
          setHeadroomCompressUserMessages(!!data.headroomCompressUserMessages);
          setHeadroomPerApiKeyProject(!!data.headroomPerApiKeyProject);
          setInherited(data.tokenSaverInherited || []);
          setScoped(!!data.tokenSaverScoped);
          setIsAdmin(!data.tokenSaverScoped);
          setCodeAware(data.headroomCodeAware === true);
          setKompress(data.headroomKompress !== false);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setPxpipeEnabled(!!data.pxpipeEnabled);
          if (typeof data.pxpipeMinChars === "number") setPxpipeMinChars(data.pxpipeMinChars);
          if (data.decisionRouter) {
            setDrConfig(data.decisionRouter);
            setDrComboStrategies(data.comboStrategies || {});
          }
          refreshHeadroomStatus();
          // PRD: run the PXPIPE health check automatically when the page opens
          refreshPxpipeStatus().then(runPxpipeHealth);
        }
      } catch {}
    };
    loadSettings();
    fetch("/api/providers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setDrConnections(data?.connections || []))
      .catch(() => {});
  }, [refreshHeadroomStatus, refreshPxpipeStatus, runPxpipeHealth]);

  const headroomRunning = !!headroomStatus.running;
  const headroomStatusLabel = headroomStatus.loading
    ? "Checking…"
    : headroomRunning
      ? "Running"
      : headroomStatus.localUrl !== false && !headroomStatus.installed
        ? "Not installed"
        : headroomStatus.localUrl !== false
          ? "Stopped"
          : "External";
  const headroomLocalUrl = headroomStatus.localUrl !== false;
  const headroomCanStart = !!headroomStatus.canStart;
  const headroomManaged =
    headroomLocalUrl && !!headroomStatus.managedPid;
  // A user can only turn Headroom on or off once the admin has it set up;
  // with nothing installed the row would be a dead switch, so it is hidden.
  const headroomInstalled = headroomRunning || !!headroomStatus.installed || !headroomLocalUrl;
  const showHeadroomRow = isAdmin || headroomInstalled;

  const pxpipeHealthy = pxpipeHealth?.healthy === true;
  const pxpipeStatusLabel = pxpipeStatus.loading
    ? "Checking…"
    : pxpipeStatus.installing
      ? "Installing…"
      : !pxpipeStatus.installed
        ? "Not installed"
        : pxpipeHealthy
          ? "Healthy"
          : pxpipeStatus.running
            ? "Running"
            : "Stopped";
  const pxpipeChipClass =
    pxpipeHealthy || pxpipeStatus.running
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  // ── Decision Router derived state ──────────────────────────────────────────
  const DR_MODES = [
    { value: "off", label: "Off" },
    { value: "shadow", label: "Shadow" },
    { value: "enforce", label: "Enforce" },
  ];
  const DR_PRESETS = [
    { value: "cautious", label: "Cautious", minConfidence: 0.8, switchConfidence: 0.9 },
    { value: "balanced", label: "Balanced", minConfidence: 0.7, switchConfidence: 0.85 },
    { value: "eager", label: "Eager", minConfidence: 0.6, switchConfidence: 0.75 },
  ];
  const DR_TOOL_MODES = [
    { value: "off", label: "Off — models only" },
    { value: "hint", label: "Hint — suggest, never pin" },
    { value: "forced", label: "Forced — allow pinning" },
  ];

  const drGateways = getProvidersByKind("systemone");
  const drGateway = drConfig && drGateways.find((g) => g.id === drConfig.provider || g.alias === drConfig.provider);
  const drGatewayId = drGateway?.id || drConfig?.provider;
  // Only show gateways the user actually has a connection to
  const drConnectedGateways = drGateways.filter((g) =>
    drConnections.some((c) => c.provider === g.id),
  );
  const drConn = drConnections.find((c) => c.provider === drGatewayId);
  const drConnBroken = drConn?.testStatus === "unavailable";
  const drAutoCombos = Object.entries(drComboStrategies)
    .filter(([, v]) => v?.fallbackStrategy === "auto")
    .map(([name]) => name);
  const drActivePreset = drConfig && DR_PRESETS.find(
    (p) => p.minConfidence === drConfig.minConfidence && p.switchConfidence === drConfig.switchConfidence,
  )?.value || "custom";

  const drPatch = (next) => {
    setDrConfig(next);
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionRouter: next }),
    }).catch(() => {});
  };
  const drSet = (key, value) => drConfig && drPatch({ ...drConfig, [key]: value });
  const drSetPreset = (value) => {
    const p = DR_PRESETS.find((x) => x.value === value);
    if (p && drConfig) drPatch({ ...drConfig, minConfidence: p.minConfidence, switchConfidence: p.switchConfidence });
  };
  const drSetGateway = (id) => {
    if (!drConfig) return;
    const next = drGateways.find((g) => g.id === id);
    const untouched = !drGateway?.systemoneConfig?.defaultModel
      || drConfig.model === drGateway.systemoneConfig.defaultModel;
    drPatch({
      ...drConfig,
      provider: id,
      model: untouched ? (next?.systemoneConfig?.defaultModel || drConfig.model) : drConfig.model,
    });
  };
  const drHandleTest = async () => {
    setDrProbe({ ok: null, message: "Testing…" });
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: drGatewayId }),
      });
      const data = await res.json().catch(() => ({}));
      setDrProbe(res.ok && data?.valid
        ? { ok: true, message: "Decision endpoint answered." }
        : { ok: false, message: data?.error || "Validation failed" });
    } catch (e) {
      setDrProbe({ ok: false, message: e.message });
    }
  };

  return (
    <div className="space-y-6 p-6">
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Token Saver
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <DefaultBadge keys={["rtkEnabled"]} scoped={scoped} inherited={inherited} />
              <ResetLink keys={["rtkEnabled"]} scoped={scoped} inherited={inherited} onReset={resetToDefault} />
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Rewrites long command output (git, grep, ls, tree, logs) into a compact
              form before it reaches the model, keeping file names and results.
              Nothing you type changes — 60-90% fewer input tokens.
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        {showHeadroomRow && (
        <div className="flex items-center justify-between py-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress context{" "}
                <DefaultBadge keys={["headroomEnabled"]} scoped={scoped} inherited={inherited} />
                <ResetLink keys={["headroomEnabled"]} scoped={scoped} inherited={inherited} onReset={resetToDefault} />
                <a
                  href="https://github.com/chopratejas/headroom"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (Headroom)
                </a>
              </p>
              {isAdmin && (
                <>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${headroomRunning ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
                  >
                    {headroomStatusLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowHeadroomInstallModal(true)}
                    className="text-xs text-primary underline hover:opacity-80"
                  >
                    {headroomRunning ? "Manage" : "Setup"}
                  </button>
                </>
              )}
            </div>
            <p className="text-sm text-text-muted mt-1">
              Sends the conversation through the Headroom service, which shortens
              long text the other compressors cannot read — prose, JSON, web pages.
              Runs before the request reaches the provider, so you pay for less.
            </p>
          </div>
          <Toggle
            checked={headroomEnabled}
            onChange={() => handleHeadroomEnabled(!headroomEnabled)}
          />
        </div>
        )}
        {isAdmin && headroomStatus.installed && (
          <div className="mb-3 ml-1 pl-3 pb-4 border-l-2 border-border">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-text-muted">
                Compression extras
                {headroomExtras.version ? ` · v${headroomExtras.version}` : ""}:
              </span>
              {headroomExtras.available.map((extra) => {
                const installed = !!headroomExtras.extras[extra];
                const pending = pendingExtras.includes(extra);
                const extraTitle =
                  extra === "code"
                    ? "tree-sitter AST compression for code responses"
                    : "Kompress-v2 HF model for prose/agentic traces (~+1GB)";

                if (installed) {
                  const active = extra === "code" ? codeAware : kompress;
                  return (
                    <div
                      key={extra}
                      className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-success/40 bg-success/5 text-text"
                      title={extraTitle}
                    >
                      <Toggle
                        size="sm"
                        checked={active}
                        disabled={restartingProxy}
                        onChange={() => toggleExtraActive(extra, !active)}
                      />
                      <span className="font-medium">[{extra}]</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveExtra(extra)}
                        disabled={removingExtra === extra}
                        className="ml-1 text-error underline hover:opacity-80 disabled:opacity-50"
                        title={`Uninstall [${extra}]`}
                      >
                        {removingExtra === extra ? "Uninstalling…" : "Uninstall"}
                      </button>
                    </div>
                  );
                }

                return (
                  <label
                    key={extra}
                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border cursor-pointer transition-colors ${
                      pending
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-text-muted hover:bg-surface-2"
                    }`}
                    title={extraTitle}
                  >
                    <input
                      type="checkbox"
                      className="w-3 h-3"
                      checked={pending}
                      onChange={() => togglePendingExtra(extra)}
                    />
                    <span className="font-medium">[{extra}]</span>
                    <span className="opacity-70">not installed</span>
                  </label>
                );
              })}
              {pendingExtras.length > 0 && (
                <button
                  onClick={handleInstallExtras}
                  disabled={extrasActionLoading}
                  className="text-xs px-2.5 py-1 rounded bg-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                  {extrasActionLoading
                    ? "Installing…"
                    : `Install [proxy,${pendingExtras.join(",")}]`}
                </button>
              )}
            </div>
            {extrasActionError && (
              <p className="text-xs text-error mt-1">{extrasActionError}</p>
            )}
            {restartingProxy && (
              <p className="text-xs text-text-muted mt-1">Restarting proxy…</p>
            )}
            {(extrasActionLoading || removingExtra) && installLog && (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface-2 p-2 text-[10px] leading-tight text-text-muted whitespace-pre-wrap">
                {installLog}
              </pre>
            )}
            <p className="text-xs text-text-muted mt-1">
              Installing adds the package; use <code>on</code>/<code>off</code>{" "}
              to activate it (restarts the proxy). Default install is{" "}
              <code>[proxy]</code> only (SmartCrusher for JSON). Adding{" "}
              <code>[code]</code> enables AST compression
              (Python/JS/TS/Go/Rust/Java/C/C++/Perl). Adding <code>[ml]</code>{" "}
              enables the Kompress-v2 HF model for prose/agentic traces but
              adds ~1 GB (torch + huggingface-hub).
            </p>
          </div>
        )}
        <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <DefaultBadge keys={["cavemanEnabled", "cavemanLevel"]} scoped={scoped} inherited={inherited} />
              <ResetLink keys={["cavemanEnabled", "cavemanLevel"]} scoped={scoped} inherited={inherited} onReset={resetToDefault} />
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Asks the model to answer in a clipped style, dropping filler and
              pleasantries. Shortens the replies you read, not what you send —
              around 65% fewer output tokens.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <DefaultBadge keys={["ponytailEnabled", "ponytailLevel"]} scoped={scoped} inherited={inherited} />
              <ResetLink keys={["ponytailEnabled", "ponytailLevel"]} scoped={scoped} inherited={inherited} onReset={resetToDefault} />
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Asks the model to write less code: reuse what exists, prefer the
              standard library, delete rather than add. Changes the answers you get,
              not the size of the request.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
        {/* PXPIPE hidden from UI — experimental, not exposed to users yet */}
        {false && (
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress prompts as images{" "}
                <a
                  href="https://github.com/teamchong/pxpipe"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (PXPIPE)
                </a>
              </p>
              <span className={`text-xs px-2 py-0.5 rounded ${pxpipeChipClass}`}>
                {pxpipeStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowPxpipeModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {pxpipeStatus.installed ? "Manage" : "Setup"}
              </button>
              <a
                href="/dashboard/pxpipe"
                className="text-xs text-primary underline hover:opacity-80"
              >
                Dashboard
              </a>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Transforms large textual context into optimized images before
              sending to the LLM. Ideal for huge prompts, tool outputs and long
              conversations.
            </p>
          </div>
          <Toggle
            checked={pxpipeEnabled}
            disabled={!pxpipeStatus.installed}
            onChange={() => handlePxpipeEnabled(!pxpipeEnabled)}
          />
        </div>
        )}
      </Card>

      {drConfig && isAdmin && (
      <Card id="decision-router">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">route</span>
            Decision Router
          </h2>
        </div>
        <div className={`flex items-center justify-between pt-2 gap-4 ${drConfig.mode === "off" ? "" : "pb-4 border-b border-border"}`}>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Route combos automatically</p>
            <p className="text-sm text-text-muted">
              Picks which model of a combo serves each turn. Shadow mode logs
              verdicts without applying them — the baseline you measure against.
            </p>
          </div>
          <SegmentedControl
            options={DR_MODES}
            value={drConfig.mode}
            onChange={(v) => drSet("mode", v)}
            size="sm"
          />
        </div>

        {drConfig.mode !== "off" && (
          <>
            {drAutoCombos.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-4 pb-2">
                <span className="text-xs text-text-muted">Routed combos:</span>
                {drAutoCombos.map((name) => (
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
            {drAutoCombos.length === 0 && (
              <p className="text-xs text-text-muted italic pt-4 pb-2">
                No combos opted in — set a combo&apos;s strategy to &quot;auto&quot; to route it.
              </p>
            )}

            <div className="flex items-center justify-between pt-4 border-t border-border gap-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">How decisive</p>
                <p className="text-sm text-text-muted">
                  {drActivePreset === "custom"
                    ? "Custom thresholds — adjust below."
                    : DR_PRESETS.find((p) => p.value === drActivePreset)?.label + " — " +
                      (drActivePreset === "cautious" ? "acts only on near-certain verdicts."
                        : drActivePreset === "eager" ? "also acts on weaker verdicts."
                        : "acts on clear verdicts.")}
                </p>
              </div>
              <SegmentedControl
                options={DR_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                value={drActivePreset === "custom" ? null : drActivePreset}
                onChange={drSetPreset}
                size="sm"
              />
            </div>

            <div className="pt-4 border-t border-border">
              <button
                type="button"
                onClick={() => setDrExpanded(!drExpanded)}
                className="inline-flex w-fit items-center gap-1 text-xs text-text-muted hover:text-primary"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {drExpanded ? "expand_less" : "expand_more"}
                </span>
                Advanced
              </button>

              {drExpanded && (
                <div className="flex flex-col gap-4 mt-3 rounded-lg border border-black/5 p-3 dark:border-white/5">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Select
                      label="Gateway"
                      options={drConnectedGateways.length > 0
                        ? drConnectedGateways.map((g) => ({ value: g.id, label: g.name }))
                        : drGateways.map((g) => ({ value: g.id, label: g.name }))}
                      value={drGatewayId}
                      onChange={(e) => drSetGateway(e.target.value)}
                      hint={drConnectedGateways.length > 0
                        ? "Only gateways with an active connection."
                        : "No connections — add one in Tools & Providers."}
                    />
                    <Input
                      label="Model"
                      value={drConfig.model ?? ""}
                      onChange={(e) => drSet("model", e.target.value)}
                      placeholder={drGateway?.systemoneConfig?.defaultModel || ""}
                      hint="The decision model. Swap it by editing this field."
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Select
                      label="Tool routing"
                      options={DR_TOOL_MODES.map((m) => ({ value: m.value, label: m.label }))}
                      value={drConfig.toolMode}
                      onChange={(e) => drSet("toolMode", e.target.value)}
                      hint="How far a tool verdict may go."
                    />
                    <div className="flex flex-col gap-3">
                      <Input
                        label="Min confidence"
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={drConfig.minConfidence}
                        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) drSet("minConfidence", n); }}
                        hint="Below this the verdict is discarded."
                      />
                      <Input
                        label="Switch confidence"
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={drConfig.switchConfidence}
                        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) drSet("switchConfidence", n); }}
                        hint="At or above this it switches; below, needs two agreeing verdicts."
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">Cap reasoning on mechanical turns</p>
                      <p className="text-xs text-text-muted">
                        The verdict that picks the model also caps the reasoning budget.
                      </p>
                    </div>
                    <Toggle size="sm" checked={drConfig.effort === true} onChange={() => drSet("effort", drConfig.effort !== true)} />
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/5">{drGateway?.name || drGatewayId}</span>
                    {drConn ? (
                      <span className={drConnBroken ? "text-amber-600 dark:text-amber-500" : "text-text-muted"}>
                        {drConn.name || "connection"}
                        {drConnBroken ? " (marked unavailable)" : ""}
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-500">
                        no connection — add one in Tools &amp; Providers
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 flex-wrap">
                    <Button size="sm" variant="secondary" onClick={drHandleTest}>Test</Button>
                    {drProbe && (
                      <span className={`text-xs ${drProbe.ok === false ? "text-error" : drProbe.ok ? "text-success" : "text-text-muted"}`}>
                        {drProbe.message}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
      )}

      <Modal
        isOpen={showHeadroomInstallModal}
        title={headroomRunning ? "Headroom" : "Setup Headroom"}
        onClose={() => setShowHeadroomInstallModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span
              className={headroomRunning ? "text-success" : "text-warning"}
            >
              {headroomStatusLabel}
            </span>
          </div>
          {headroomRunning && (
            <a
              href="/api/headroom/proxy/dashboard"
              target="_blank"
              rel="noreferrer"
              className="w-full rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
            >
              Open Headroom Dashboard
            </a>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Proxy URL</p>
            <Input
              value={headroomUrl}
              onChange={(e) => setHeadroomUrl(e.target.value)}
              onBlur={handleHeadroomUrlBlur}
              placeholder="http://localhost:8787"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Use a local proxy for Start/Stop, or an external Docker sidecar
              like http://headroom:8787.
            </p>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Compress user messages</p>
              <p className="text-xs text-text-muted">
                Also compress the user turns, not just tool output. Worth trying when
                messages dominate the payload.
              </p>
            </div>
            <Toggle
              checked={headroomCompressUserMessages}
              onChange={(v) => { setHeadroomCompressUserMessages(v); patchSetting({ headroomCompressUserMessages: v }); }}
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Per-API-key project</p>
              <p className="text-xs text-text-muted">
                Send each key&rsquo;s traffic to its own Headroom project (<span className="font-mono">/p/&lt;key name&gt;</span>),
                so per-project stats separate callers instead of pooling them.
              </p>
            </div>
            <Toggle
              checked={headroomPerApiKeyProject}
              onChange={(v) => { setHeadroomPerApiKeyProject(v); patchSetting({ headroomPerApiKeyProject: v }); }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Timeout (ms)</p>
            <Input
              value={String(headroomTimeoutMs)}
              onChange={(e) => setHeadroomTimeoutMs(e.target.value)}
              onBlur={handleHeadroomTimeoutBlur}
              placeholder="3000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Request timeout in milliseconds. Defaults to 3000 ms.
            </p>
          </div>
          {headroomManaged ? (
            <Button
              onClick={handleHeadroomStop}
              variant="ghost"
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Stopping…" : "Stop Headroom"}
            </Button>
          ) : headroomRunning ? (
            <p className="text-sm text-success">
              Headroom proxy is reachable. You can enable the token saver.
            </p>
          ) : headroomCanStart ? (
            <Button
              onClick={handleHeadroomStart}
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Starting…" : "Start Headroom"}
            </Button>
          ) : !headroomLocalUrl ? (
            <p className="text-sm text-warning">
              Start Headroom separately at the configured URL, then recheck.
            </p>
          ) : !headroomStatus.python ? (
            <p className="text-sm text-warning">
              Python ≥ 3.10 required for local managed mode. Install Python
              first, or use an external proxy URL.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Install then click Start:</p>
              <div className="flex items-center gap-2">
                <pre className="flex-1 rounded bg-black/5 dark:bg-white/5 p-2 text-xs font-mono overflow-x-auto">
                  {`pip install "headroom-ai[proxy]"`}
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    copy(`pip install "headroom-ai[proxy]"`)
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {headroomActionError && (
            <p className="text-sm text-warning">{headroomActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshHeadroomStatus()}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button
              onClick={() => setShowHeadroomInstallModal(false)}
              fullWidth
            >
              Done
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={false}
        title={pxpipeStatus.installed ? "PXPIPE" : "Setup PXPIPE"}
        onClose={() => setShowPxpipeModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Compress prompts using multimodal encoding. Runs in-process — no
            extra server or environment variables required.
          </p>
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span className={pxpipeHealthy || pxpipeStatus.running ? "text-success" : "text-warning"}>
              {pxpipeStatusLabel}
              {pxpipeStatus.version ? ` · v${pxpipeStatus.version}` : ""}
            </span>
          </div>
          {pxpipeHealth?.checks?.length > 0 && (
            <div className="flex flex-col gap-1 rounded border border-border p-3">
              <p className="text-sm font-medium mb-1">Health check</p>
              {pxpipeHealth.checks.map((check) => (
                <div key={check.id} className="flex items-center justify-between text-xs">
                  <span className={check.ok ? "text-success" : "text-warning"}>
                    {check.ok ? "●" : "○"} {check.label}
                  </span>
                  {check.detail && (
                    <span className="text-text-muted font-mono truncate max-w-[50%]">{check.detail}</span>
                  )}
                </div>
              ))}
              {pxpipeHealth.error && (
                <p className="text-xs text-warning mt-1">{pxpipeHealth.error}</p>
              )}
            </div>
          )}
          {!pxpipeStatus.installed ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-warning">PXPIPE is not installed.</p>
              <Button
                onClick={() => pxpipeAction("install")}
                fullWidth
                disabled={pxpipeActionLoading || pxpipeStatus.installing}
              >
                {pxpipeActionLoading || pxpipeStatus.installing ? "Installing…" : "Install"}
              </Button>
              <p className="text-xs text-text-muted">
                Installs the npm package <code className="font-mono">pxpipe-proxy</code> into
                the 9Router data directory. May take a few minutes.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {pxpipeStatus.running ? (
                <>
                  <Button onClick={() => pxpipeAction("restart")} variant="ghost" disabled={pxpipeActionLoading}>
                    Restart
                  </Button>
                  <Button onClick={() => pxpipeAction("stop")} variant="ghost" disabled={pxpipeActionLoading}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button onClick={() => pxpipeAction("start")} disabled={pxpipeActionLoading}>
                  {pxpipeActionLoading ? "Starting…" : "Start"}
                </Button>
              )}
              <Button onClick={() => pxpipeAction("install")} variant="ghost" disabled={pxpipeActionLoading}>
                Repair
              </Button>
              <a
                href="/dashboard/pxpipe#logs"
                className="col-span-2 rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
              >
                Open Logs
              </a>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Minimum prompt size (chars)</p>
            <Input
              value={String(pxpipeMinChars)}
              onChange={(e) => setPxpipeMinChars(e.target.value)}
              onBlur={handlePxpipeMinCharsBlur}
              placeholder="25000"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Requests smaller than this bypass PXPIPE and are sent as-is.
            </p>
          </div>
          {pxpipeActionError && (
            <p className="text-sm text-warning">{pxpipeActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshPxpipeStatus().then(runPxpipeHealth)}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button onClick={() => setShowPxpipeModal(false)} fullWidth>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!extrasConfirm}
        onClose={() => setExtrasConfirm(null)}
        onConfirm={() => {
          const fn = extrasConfirm?.onConfirm;
          setExtrasConfirm(null);
          fn?.();
        }}
        title={extrasConfirm?.title}
        message={extrasConfirm?.message}
        confirmText={extrasConfirm?.confirmText}
        variant={extrasConfirm?.variant}
      />
    </div>
  );
}

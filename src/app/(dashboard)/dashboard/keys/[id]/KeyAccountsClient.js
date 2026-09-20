"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { Card, Button, Input, Select, CardSkeleton, Toggle } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { cn } from "@/shared/utils/cn";

function connectionLabel(connection) {
  return connection.displayName || connection.name || connection.email || connection.id.slice(0, 8);
}

const BUDGET_PERIOD_OPTIONS = [
  { value: "month", label: "Monthly" },
  { value: "total", label: "Lifetime" },
];

// Spent-vs-cap thresholds — same 70/30 bands as the quota dashboard's
// QuotaProgressBar, mirrored because this tracks spend (higher = worse)
// instead of remaining quota (higher = better).
function spendBarColor(percentUsed) {
  if (percentUsed >= 100) return "bg-red-500";
  if (percentUsed >= 80) return "bg-yellow-500";
  return "bg-green-500";
}

function SpendCapBar({ spentUsd, limitUsd }) {
  const pct = limitUsd > 0 ? Math.min(100, (spentUsd / limitUsd) * 100) : 0;
  return (
    <div className="mt-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]">
        <div className={cn("h-full rounded-full transition-all", spendBarColor(pct))} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-text-muted">
        ${spentUsd.toFixed(2)} / ${limitUsd.toFixed(2)} spent
      </p>
    </div>
  );
}

SpendCapBar.propTypes = { spentUsd: PropTypes.number.isRequired, limitUsd: PropTypes.number.isRequired };

export default function KeyAccountsClient({ keyId }) {
  const [apiKey, setApiKey] = useState(null);
  const [connections, setConnections] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [spendByConn, setSpendByConn] = useState(new Map());
  const [budgets, setBudgets] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [keyRes, provRes, spendRes] = await Promise.all([
          fetch(`/api/keys/${keyId}`),
          fetch("/api/providers"),
          fetch(`/api/keys/${keyId}/spend`),
        ]);
        if (!keyRes.ok) throw new Error("Key not found");
        const keyData = await keyRes.json();
        const provData = provRes.ok ? await provRes.json() : { connections: [] };
        const spendData = spendRes.ok ? await spendRes.json() : { spend: [] };
        if (cancelled) return;
        setApiKey(keyData.key);
        setConnections(provData.connections || []);
        setSelected(new Set(keyData.key?.allowedConnectionIds || []));
        setSpendByConn(new Map((spendData.spend || []).map((s) => [s.connectionId, s])));
        setBudgets(new Map((spendData.spend || []).filter((s) => s.budget).map((s) => [s.connectionId, s.budget])));
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load key");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [keyId]);

  const setBudget = useCallback((connId, patch) => {
    setBudgets((prev) => {
      const next = new Map(prev);
      next.set(connId, { limitUsd: 1, period: "month", ...next.get(connId), ...patch });
      return next;
    });
  }, []);

  const clearBudget = useCallback((connId) => {
    setBudgets((prev) => {
      const next = new Map(prev);
      next.delete(connId);
      return next;
    });
  }, []);

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase();
    const byProvider = new Map();
    for (const conn of connections) {
      if (term && !`${conn.provider} ${connectionLabel(conn)}`.toLowerCase().includes(term)) continue;
      if (!byProvider.has(conn.provider)) byProvider.set(conn.provider, []);
      byProvider.get(conn.provider).push(conn);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [connections, search]);

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // connectionBudgets, keyed by connection id, only for still-bound accounts.
      const connectionBudgets = Object.fromEntries([...budgets].filter(([connId]) => selected.has(connId)));
      const response = await fetch(`/api/keys/${keyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedConnectionIds: [...selected], connectionBudgets }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save");
      setApiKey(data.key);
      setSelected(new Set(data.key?.allowedConnectionIds || []));
      const spendRes = await fetch(`/api/keys/${keyId}/spend`);
      const spendData = spendRes.ok ? await spendRes.json() : { spend: [] };
      setSpendByConn(new Map((spendData.spend || []).map((s) => [s.connectionId, s])));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [keyId, selected, budgets]);

  if (loading) return <CardSkeleton />;

  if (error && !apiKey) {
    return (
      <Card padding="lg">
        <p className="text-sm text-red-500">{error}</p>
        <Link href="/dashboard/endpoint" className="mt-4 inline-block text-sm text-primary">
          Back to API keys
        </Link>
      </Card>
    );
  }

  const unrestricted = selected.size === 0;

  return (
    <div className="space-y-6">
      <Card padding="lg">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link href="/dashboard/endpoint" className="text-xs text-text-muted hover:text-primary">
              ← API keys
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold text-text-primary">{apiKey?.name || "Unnamed key"}</h1>
              {(apiKey?.tags || []).map((tag) => (
                <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                  {tag}
                </span>
              ))}
            </div>
            <p className="mt-1 text-sm text-text-muted">
              {unrestricted
                ? "No accounts linked — this key can use every account."
                : `${selected.size} account${selected.size === 1 ? "" : "s"} linked. Routing, /v1/models and the quota tracker only see these.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!unrestricted && (
              <Button variant="secondary" onClick={() => setSelected(new Set())} disabled={saving}>
                Clear all
              </Button>
            )}
            <Button icon="save" onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </Card>

      <Card padding="lg">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search accounts..."
          icon="search"
        />

        {grouped.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">No accounts found.</p>
        ) : (
          <div className="mt-4 space-y-6">
            {grouped.map(([provider, providerConnections]) => (
              <div key={provider}>
                <div className="mb-2 flex items-center gap-2">
                  <ProviderIcon
                    src={`/providers/${provider}.png`}
                    alt={provider}
                    size={20}
                    className="size-5 rounded object-contain"
                    fallbackText={provider.slice(0, 2).toUpperCase()}
                  />
                  <span className="text-sm font-medium capitalize text-text-primary">{provider}</span>
                </div>
                <div className="flex flex-col">
                  {providerConnections.map((conn) => {
                    const isSelected = selected.has(conn.id);
                    const spend = spendByConn.get(conn.id);
                    const budget = budgets.get(conn.id);
                    // A cap only makes sense once the account is linked and its
                    // provider is consumption-billed — a subscription account
                    // (Claude Pro, Copilot, ...) has no per-request cost to cap.
                    const canBudget = isSelected && spend && spend.billing === "usage";
                    return (
                      <div
                        key={conn.id}
                        className="border-b border-black/[0.03] py-2.5 last:border-b-0 dark:border-white/[0.03]"
                      >
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-text-primary">{connectionLabel(conn)}</p>
                            <p className="text-xs text-text-muted">
                              {conn.authType}
                              {conn.isActive === false ? " · inactive" : ""}
                            </p>
                          </div>
                          <Toggle
                            size="sm"
                            checked={isSelected}
                            onChange={() => toggle(conn.id)}
                            title={isSelected ? "Unlink account" : "Link account"}
                          />
                        </div>
                        {isSelected && spend && spend.billing !== "usage" && (
                          <p className="mt-1.5 text-[11px] text-text-muted">Subscription plan — spend caps don&apos;t apply.</p>
                        )}
                        {isSelected && !spend && (
                          <p className="mt-1.5 text-[11px] text-text-muted">Save to configure a spend cap for this account.</p>
                        )}
                        {canBudget && (
                          <div className="mt-2 flex flex-wrap items-end gap-2">
                            <Input
                              type="number"
                              min="0.01"
                              step="0.01"
                              className="w-28"
                              placeholder="No cap"
                              value={budget?.limitUsd ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "") { clearBudget(conn.id); return; }
                                setBudget(conn.id, { limitUsd: Number(v) });
                              }}
                            />
                            <Select
                              className="w-32"
                              options={BUDGET_PERIOD_OPTIONS}
                              value={budget?.period || "month"}
                              onChange={(e) => setBudget(conn.id, { period: e.target.value })}
                              disabled={!budget}
                            />
                            {budget && (
                              <Button variant="secondary" size="sm" onClick={() => clearBudget(conn.id)}>
                                Remove cap
                              </Button>
                            )}
                          </div>
                        )}
                        {canBudget && budget && <SpendCapBar spentUsd={spend.spentUsd} limitUsd={budget.limitUsd} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

KeyAccountsClient.propTypes = {
  keyId: PropTypes.string.isRequired,
};

"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Input, Modal, ConfirmModal, CardSkeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { visibleEndpointsFor } from "@/shared/constants/managementEndpoints";

function maskKey(fullKey) {
  if (!fullKey || fullKey.length <= 10) return fullKey || "";
  return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
}

export default function AccountClient() {
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [keys, setKeys] = useState([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [createdKey, setCreatedKey] = useState(null);
  const [adminKeyError, setAdminKeyError] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  const fetchKeys = useCallback(() => {
    return fetch("/api/keys")
      .then((res) => (res.ok ? res.json() : { keys: [] }))
      .then((data) => setKeys(data.keys || []))
      .catch(() => { /* keep last known list */ })
      .finally(() => setKeysLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => {})
      .finally(() => setStatusLoading(false));
    fetchKeys();
  }, [fetchKeys]);

  const ownOwner = status?.owner ?? null;
  const isAdmin = !!status?.isAdmin;
  const visibleEndpoints = visibleEndpointsFor(isAdmin);
  const showIdentityPanel = status?.loginMethod === "OIDC" || status?.loginMethod === "SAML";

  const myAdminKey = keys.find((k) => k.kind === "admin" && k.owner === ownOwner) || null;
  // Every other owner's administration key — the caller's own is already
  // covered by the create/rotate/revoke block above, with full visibility.
  const otherAdminKeys = isAdmin
    ? keys.filter((k) => k.kind === "admin" && k.owner !== ownOwner)
    : [];

  // Same create-if-none/rotate/revoke logic the Endpoint page used to own —
  // moved here as-is (rotate has no dedicated endpoint, so it revokes then
  // creates, same as before).
  const handleCreateAdminKey = async () => {
    setAdminKeyError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Administration key", kind: "admin", owner: ownOwner }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreatedKey(data.key);
        await fetchKeys();
      } else {
        setAdminKeyError(data.error || "Failed to create administration key");
      }
    } catch {
      setAdminKeyError("An error occurred");
    }
  };

  const handleRevokeAdminKey = (id) => {
    setConfirmState({
      title: "Revoke Administration Key",
      message: "Revoke this administration key? Anything using it to drive the dashboard REST API will stop working immediately.",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) setKeys((prev) => prev.filter((k) => k.id !== id));
        } catch { /* leave the list as-is; the user can retry */ }
      },
    });
  };

  const handleRotateAdminKey = (id) => {
    setConfirmState({
      title: "Rotate Administration Key",
      message: "Rotate this administration key? The old key stops working immediately and a new one is shown once.",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const del = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (!del.ok) return;
          setKeys((prev) => prev.filter((k) => k.id !== id));
          await handleCreateAdminKey();
        } catch { /* leave the list as-is; the user can retry */ }
      },
    });
  };

  if (statusLoading || keysLoading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {showIdentityPanel && (
        <Card title="Identity" icon="badge" subtitle="What the current SSO session reports">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            {(status.oidcName || status.samlName) && (
              <div>
                <dt className="text-xs text-text-muted">Name</dt>
                <dd className="text-sm font-medium">{status.oidcName || status.samlName}</dd>
              </div>
            )}
            {(status.oidcEmail || status.samlEmail) && (
              <div>
                <dt className="text-xs text-text-muted">Email</dt>
                <dd className="text-sm font-medium">{status.oidcEmail || status.samlEmail}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-text-muted">Provider</dt>
              <dd className="text-sm font-medium">{status.loginMethod}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Role</dt>
              <dd className="text-sm font-medium">{isAdmin ? "Administrator" : "Member"}</dd>
            </div>
          </dl>
        </Card>
      )}

      <Card title="Administrative API keys" icon="admin_panel_settings">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Your administration key</p>
            <p className="text-xs text-text-muted">
              Drives the dashboard REST API (combos, providers, keys, settings) as your own
              identity, instead of routing LLM requests. One per owner.
            </p>
            {adminKeyError && <p className="mt-1 text-xs text-red-500">{adminKeyError}</p>}
          </div>
          {myAdminKey ? (
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" onClick={() => handleRotateAdminKey(myAdminKey.id)}>
                Rotate
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleRevokeAdminKey(myAdminKey.id)}>
                Revoke
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={handleCreateAdminKey} className="shrink-0">
              Create
            </Button>
          )}
        </div>

        {isAdmin && (
          <div className="mt-6">
            <p className="text-sm font-medium mb-2">All administration keys</p>
            {otherAdminKeys.length === 0 ? (
              <p className="text-xs text-text-muted">No other owner has an administration key.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm text-left">
                  <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
                    <tr>
                      <th className="px-3 py-2">Owner</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Created</th>
                      <th className="px-3 py-2">Key</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {otherAdminKeys.map((key) => (
                      <tr key={key.id}>
                        <td className="px-3 py-2">{key.owner === "@admin" ? "Admin only" : key.owner}</td>
                        <td className="px-3 py-2">{key.name}</td>
                        <td className="px-3 py-2 text-text-muted">{new Date(key.createdAt).toLocaleDateString()}</td>
                        <td className="px-3 py-2 font-mono text-xs text-text-muted">{maskKey(key.key)}</td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="ghost" onClick={() => handleRevokeAdminKey(key.id)}>
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="mt-6">
          <p className="text-sm font-medium mb-1">Endpoint reference</p>
          <p className="text-xs text-text-muted mb-3">
            Send the key as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> or{" "}
            <code className="font-mono">x-api-key: &lt;key&gt;</code>. Administration keys are refused
            on <code className="font-mono">/v1/*</code> routing endpoints. Your administration key can
            call the endpoints below{isAdmin ? "" : ", not the admin-only ones"} — when resource scoping
            is on, responses are limited to your own combos, providers and keys.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm text-left">
              <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
                <tr>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Path</th>
                  <th className="px-3 py-2">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleEndpoints.map((ep) => (
                  <tr key={`${ep.method} ${ep.path}`}>
                    <td className="px-3 py-2 font-mono text-xs">{ep.method}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {ep.path}
                      {ep.adminOnly && (
                        <span className="ml-2 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-sans uppercase text-text-muted">
                          admin
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{ep.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Modal isOpen={!!createdKey} title="Administration Key Created" onClose={() => setCreatedKey(null)}>
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input value={createdKey || ""} readOnly className="flex-1 font-mono text-sm" />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}

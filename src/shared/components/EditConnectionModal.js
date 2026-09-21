"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  // Credential fields start blank — "leave blank to keep the current
  // credential" (same convention as the generic apiKey field above), never
  // pre-filled from the stored secret (GET already strips it).
  const [bedrockData, setBedrockData] = useState({
    authMethod: "api_key",
    region: "",
    homeRegion: "",
    inferenceProfilePrefix: "",
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    creditsUsd: "",
  });
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  // "" = shared, "@admin" = password login only, otherwise the owner's e-mail.
  const [owner, setOwner] = useState("");
  const [canAssignOwner, setCanAssignOwner] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => setCanAssignOwner(!!data?.scopeResourcesByUser && !!data?.isAdmin))
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (connection) {
      setOwner(connection.owner || "");
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      if (connection.provider === "bedrock") {
        const psd = connection.providerSpecificData || {};
        setBedrockData({
          authMethod: psd.authMethod === "iam" ? "iam" : "api_key",
          region: psd.region || "us-east-1",
          homeRegion: psd.homeRegion || "",
          inferenceProfilePrefix: psd.inferenceProfilePrefix || "",
          endpoint: psd.endpoint || "",
          accessKeyId: "",
          secretAccessKey: "",
          sessionToken: "",
          creditsUsd: typeof psd.creditsUsd === "number" ? String(psd.creditsUsd) : "",
        });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isBedrock = connection?.provider === "bedrock";
  const isBedrockIam = isBedrock && bedrockData.authMethod === "iam";
  const isBedrockGlobal = isBedrock && bedrockData.region.trim().toLowerCase() === "global";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  // IAM credential fields are optional on edit — blank means "keep the
  // current value" (route.js PUT merges this onto the existing
  // providerSpecificData, so an omitted key survives untouched). Region/
  // prefix/endpoint are ordinary editable fields and always sent.
  // creditsUsd is always sent too, but unlike those fields blank means
  // "clear it": we send null so the normalizer drops the stored value
  // instead of the PUT's merge leaving a stale credits amount in place.
  const buildBedrockSpecificData = () => {
    const next = {
      authMethod: bedrockData.authMethod,
      region: bedrockData.region.trim() || "us-east-1",
      inferenceProfilePrefix: bedrockData.inferenceProfilePrefix,
      endpoint: bedrockData.endpoint.trim(),
      ...(isBedrockGlobal ? { homeRegion: bedrockData.homeRegion.trim() } : {}),
    };
    const creditsUsd = Number(bedrockData.creditsUsd.trim());
    next.creditsUsd = bedrockData.creditsUsd.trim() && Number.isFinite(creditsUsd) && creditsUsd > 0 ? creditsUsd : null;
    if (isBedrockIam) {
      if (bedrockData.accessKeyId.trim()) next.accessKeyId = bedrockData.accessKeyId.trim();
      if (bedrockData.secretAccessKey.trim()) next.secretAccessKey = bedrockData.secretAccessKey.trim();
      if (bedrockData.sessionToken.trim()) next.sessionToken = bedrockData.sessionToken.trim();
    }
    return next;
  };
  const bedrockIamCredsReady = isBedrockIam && !!bedrockData.accessKeyId.trim() && !!bedrockData.secretAccessKey.trim();

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  // Shared by the generic "Check" button (api-key providers, including
  // bedrock's api_key mode) and bedrock's own IAM "Validate" button below —
  // the two differ only in whether a fresh apiKey is required.
  const buildValidatePayload = () => ({
    provider: connection.provider,
    apiKey: formData.apiKey,
    ...(isAzure ? { providerSpecificData: azureData } : {}),
    ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
    ...(isBedrock ? { providerSpecificData: buildBedrockSpecificData() } : {}),
    ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
  });

  const runValidate = async () => {
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildValidatePayload()),
      });
      const data = await res.json();
      const isValid = !!data.valid;
      setValidationResult(isValid ? "success" : "failed");
      return isValid;
    } catch {
      setValidationResult("failed");
      return false;
    } finally {
      setValidating(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider) return;
    if (isBedrockIam ? !bedrockIamCredsReady : !formData.apiKey) return;
    await runValidate();
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      const hasNewCredential = !isOAuth && (isBedrockIam ? bedrockIamCredsReady : !!formData.apiKey);
      if (!isOAuth && formData.apiKey) updates.apiKey = formData.apiKey;
      if (hasNewCredential) {
        let isValid = validationResult === "success";
        if (!isValid) isValid = await runValidate();
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }

      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      if (isBedrock) {
        updates.providerSpecificData = buildBedrockSpecificData();
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }
      
      if (canAssignOwner) updates.owner = owner || null;

      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {canAssignOwner && (
          <Input
            label="Owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="user@company.com"
            hint={'Leave blank to share with everyone, or use "@admin" to keep it to the password login.'}
          />
        )}

        {!isOAuth && !isBedrockIam && (
          <>
            <div className="flex gap-2">
              <Input
                label={isBedrock ? "Bedrock API key (bearer token)" : "API Key"}
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isBedrock && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-sm">Amazon Bedrock Configuration</h3>
              <Badge variant="default">{isBedrockIam ? "IAM (SigV4)" : "API key"}</Badge>
            </div>
            <div className="flex flex-col gap-3">
              {isBedrockIam && (
                <>
                  <Input
                    label="AWS Access Key ID"
                    value={bedrockData.accessKeyId}
                    onChange={(e) => setBedrockData({ ...bedrockData, accessKeyId: e.target.value })}
                    placeholder="AKIA..."
                    hint="Leave blank to keep the current Access Key ID."
                  />
                  <Input
                    label="AWS Secret Access Key"
                    type="password"
                    value={bedrockData.secretAccessKey}
                    onChange={(e) => setBedrockData({ ...bedrockData, secretAccessKey: e.target.value })}
                    hint="Leave blank to keep the current Secret Access Key."
                  />
                  <Input
                    label="Session Token (optional)"
                    type="password"
                    value={bedrockData.sessionToken}
                    onChange={(e) => setBedrockData({ ...bedrockData, sessionToken: e.target.value })}
                    hint="Leave blank to keep the current session token (if any)."
                  />
                  <div className="flex items-center gap-3">
                    <Button onClick={handleValidate} disabled={!bedrockIamCredsReady || validating || saving} variant="secondary">
                      {validating ? "Validating..." : "Validate"}
                    </Button>
                    {validationResult && (
                      <Badge variant={validationResult === "success" ? "success" : "error"}>
                        {validationResult === "success" ? "Valid" : "Invalid"}
                      </Badge>
                    )}
                  </div>
                </>
              )}
              <Input
                label="Region"
                value={bedrockData.region}
                onChange={(e) => setBedrockData({ ...bedrockData, region: e.target.value })}
                placeholder="us-east-1"
              />
              {isBedrockGlobal && (
                <Input
                  label="Home Region"
                  value={bedrockData.homeRegion}
                  onChange={(e) => setBedrockData({ ...bedrockData, homeRegion: e.target.value })}
                  placeholder="Defaults to us-east-1 — set this to wherever your account has Bedrock control-plane access"
                />
              )}
              <Select
                label="Cross-Region Inference Profile"
                value={bedrockData.inferenceProfilePrefix}
                onChange={(e) => setBedrockData({ ...bedrockData, inferenceProfilePrefix: e.target.value })}
                options={[
                  { value: "", label: "None (use the model id as-is)" },
                  { value: "us.", label: "US" },
                  { value: "eu.", label: "EU" },
                  { value: "apac.", label: "APAC" },
                  { value: "global.", label: "Global" },
                ]}
              />
              <Input
                label="Endpoint Override (optional)"
                value={bedrockData.endpoint}
                onChange={(e) => setBedrockData({ ...bedrockData, endpoint: e.target.value })}
                placeholder="For a VPC endpoint or GovCloud — leave blank otherwise"
              />
              <Input
                label="Credits (USD, optional)"
                type="number"
                min="0"
                step="0.01"
                value={bedrockData.creditsUsd}
                onChange={(e) => setBedrockData({ ...bedrockData, creditsUsd: e.target.value })}
                placeholder="Total credits available for this account — enables spend tracking in the Quota Tracker"
              />
            </div>
          </div>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    owner: PropTypes.string,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};


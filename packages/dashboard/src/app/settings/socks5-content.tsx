"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle, XCircle, Network, Route } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Switch, Button, Input, Label } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nocoo/basalt/components/select";
import { SettingNote, SettingsCard } from "./settings-ui";






interface ProviderPolicy {
  id: string;
  name: string;
  use_socks5: number | null;
}

export interface Socks5Data {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  copilotPolicy: "default" | "on" | "off";
  bridgeStatus: "running" | "stopped";
  bridgePort: number | null;
  providerPolicies: ProviderPolicy[];
}

interface Socks5ContentProps {
  data: Socks5Data;
}

type PasswordState = "pristine" | "edited" | "cleared";

export function Socks5Content({ data }: Socks5ContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [host, setHost] = useState(data.host ?? "");
  const [port, setPort] = useState(data.port?.toString() ?? "");
  const [username, setUsername] = useState(data.username ?? "");
  const [password, setPassword] = useState("");
  const [passwordState, setPasswordState] = useState<PasswordState>("pristine");
  const [copilotPolicy, setCopilotPolicy] = useState(data.copilotPolicy);
  const [providerPolicies, setProviderPolicies] = useState(data.providerPolicies);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    ip?: string;
    error?: string;
    latencyMs?: number;
  } | null>(null);

  const handlePasswordChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPassword(e.target.value);
      setPasswordState("edited");
    },
    [],
  );

  const handleClearPassword = useCallback(() => {
    setPassword("");
    setPasswordState("cleared");
  }, []);

  const handleProviderPolicyChange = useCallback(
    (providerId: string, value: string) => {
      setProviderPolicies((prev) =>
        prev.map((p) =>
          p.id === providerId
            ? { ...p, use_socks5: value === "null" ? null : Number(value) }
            : p,
        ),
      );
    },
    [],
  );

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch("/api/settings/socks5/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port),
          ...(username.trim() ? { username: username.trim() } : {}),
          ...(passwordState === "edited" && password
            ? { password }
            : {}),
          // When password is pristine (not edited/cleared), tell server to use stored credentials
          ...(passwordState === "pristine" && data.hasPassword
            ? { useStoredCredentials: true }
            : {}),
        }),
      });
      const body = await res.json();
      setTestResult(body);
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setTesting(false);
    }
  }, [host, port, username, password, passwordState, data.hasPassword]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      const payload: Record<string, unknown> = {
        enabled,
        host: host.trim() || undefined,
        port: port ? Number(port) : undefined,
        username: username.trim() || null,
        copilotPolicy,
      };

      // Password three-state
      if (passwordState === "edited") {
        payload.password = password;
      } else if (passwordState === "cleared") {
        payload.password = null;
      }
      // pristine → don't include password key (undefined = preserve)

      // Only include changed provider policies
      const changedPolicies = providerPolicies.filter((p) => {
        const original = data.providerPolicies.find((op) => op.id === p.id);
        return original && original.use_socks5 !== p.use_socks5;
      });
      if (changedPolicies.length > 0) {
        payload.providerPolicies = changedPolicies.map((p) => ({
          id: p.id,
          use_socks5: p.use_socks5,
        }));
      }

      const res = await fetch("/api/settings/socks5", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        router.refresh();
        setPasswordState("pristine");
        setPassword("");
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        const body = await res.json().catch(() => null);
        setError(
          body?.error?.message ?? body?.error ?? "Failed to save settings",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }, [
    enabled,
    host,
    port,
    username,
    password,
    passwordState,
    copilotPolicy,
    providerPolicies,
    data.providerPolicies,
    router,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Proxy" description="SOCKS5 outbound connections." actions={
        <Button size="sm" onClick={handleSave} disabled={saving} className="h-8 text-xs">
          {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
          Save
        </Button>
      } />
            {saveSuccess ? (
              <span className="flex items-center gap-1 text-xs text-basalt-chart-5">
                <CheckCircle className="h-3 w-3" />
                Settings saved
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="flex items-center gap-1 text-xs text-basalt-destructive">
                <XCircle className="h-3 w-3" />
                {error}
              </span>
            ) : null}
      <div className="settings-grid">
        <SettingsCard title="SOCKS5 connection" icon={Network} tone="blue" action={<Switch id="socks5-enabled" aria-label="Use SOCKS5 proxy" checked={enabled} onCheckedChange={setEnabled} disabled={saving} />}>
          {data.enabled && <p className={`text-xs ${data.bridgeStatus === "running" ? "text-basalt-success" : "text-basalt-destructive"}`}>Bridge: {data.bridgeStatus}</p>}

          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
            <div>
              <Label htmlFor="socks5-host" className="text-xs">Host</Label>
              <Input
                id="socks5-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="proxy.example.com"
                className="h-8 text-xs font-mono"
                disabled={saving}
              />
            </div>
            <div>
              <Label htmlFor="socks5-port" className="text-xs">Port</Label>
              <Input
                id="socks5-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="1080"
                type="number"
                className="h-8 text-xs font-mono"
                disabled={saving}
              />
            </div>
          </div>

          <Collapsible defaultOpen={Boolean(data.username || data.hasPassword)}>
            <CollapsibleTrigger className="text-xs text-basalt-muted-foreground">Authentication (optional)</CollapsibleTrigger>
            <CollapsibleContent unstyled><div className="grid gap-2 pt-3 @min-[26rem]/page:grid-cols-2">
            <div>
              <Label htmlFor="socks5-username" className="text-xs">
                Username{" "}
                <span className="text-basalt-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="socks5-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                className="h-8 text-xs font-mono"
                disabled={saving}
              />
            </div>
            <div>
              <Label htmlFor="socks5-password" className="text-xs">
                Password{" "}
                <span className="text-basalt-muted-foreground">(optional)</span>
              </Label>
              <div className="flex gap-1">
                <Input
                  id="socks5-password"
                  type="password"
                  value={password}
                  onChange={handlePasswordChange}
                  placeholder={
                    passwordState === "cleared"
                      ? "Password cleared"
                      : data.hasPassword && passwordState === "pristine"
                        ? "••••••••"
                        : "password"
                  }
                  className="h-8 text-xs font-mono flex-1"
                  disabled={saving}
                />
                {(data.hasPassword || passwordState === "edited") &&
                  passwordState !== "cleared" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs text-basalt-muted-foreground hover:text-basalt-destructive"
                      onClick={handleClearPassword}
                      aria-label="Clear proxy password"
                      disabled={saving}
                    >
                      <XCircle className="h-3 w-3" />
                    </Button>
                  )}
              </div>
              {passwordState === "cleared" && (
                <p className="text-xs text-basalt-warning mt-0.5">
                  Password will be cleared on save
                </p>
              )}
            </div>
            </div></CollapsibleContent>
          </Collapsible>

          {/* Test button */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testing || !host.trim() || !port}
              className="h-8 text-xs"
            >
              {testing ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              ) : null}
              Test Connection
            </Button>
            {testResult && (
              <span
                className={`text-xs flex items-center gap-1 ${testResult.success ? "text-basalt-chart-5" : "text-basalt-destructive"}`}
              >
                {testResult.success ? (
                  <>
                    <CheckCircle className="h-3 w-3" />
                    Connected{testResult.ip ? ` via ${testResult.ip}` : ""} ({testResult.latencyMs}ms)
                  </>
                ) : (
                  <>
                    <XCircle className="h-3 w-3" />
                    {testResult.error ?? "Connection failed"}
                  </>
                )}
              </span>
            )}
          </div>
        </SettingsCard>

        <SettingsCard title="Upstream routing" icon={Route} tone="purple">
          <SettingNote>
            Copilot and GitHub use the proxy. Custom providers connect directly by default.
          </SettingNote>
          <Collapsible defaultOpen={data.enabled || data.copilotPolicy !== "default" || data.providerPolicies.some(policy => policy.use_socks5 !== null)}>
            <CollapsibleTrigger className="w-full justify-between text-xs">Upstream policies</CollapsibleTrigger>
            <CollapsibleContent unstyled><div className="space-y-3 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">GitHub Copilot</span>
            <Select value={copilotPolicy} onValueChange={(v) => setCopilotPolicy(v as "default" | "on" | "off")}>
              <SelectTrigger aria-label="GitHub Copilot proxy policy" className="w-[160px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default (On)</SelectItem>
                <SelectItem value="on">Force On</SelectItem>
                <SelectItem value="off">Force Off</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Provider policies */}
          {providerPolicies.length > 0 && (
            <div className="border-t border-basalt-border/30 pt-2 space-y-2">
              {providerPolicies.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm">{p.name}</span>
                  <Select
                    value={String(p.use_socks5 ?? "null")}
                    onValueChange={(v) => handleProviderPolicyChange(p.id, v)}
                  >
                    <SelectTrigger aria-label={`${p.name} proxy policy`} className="w-[160px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="null">Default (Off)</SelectItem>
                      <SelectItem value="1">Force On</SelectItem>
                      <SelectItem value="0">Force Off</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
            </div></CollapsibleContent>
          </Collapsible>
        </SettingsCard>
      </div>
    </div>
  );
}

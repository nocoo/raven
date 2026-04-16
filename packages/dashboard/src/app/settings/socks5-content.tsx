"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ProviderPolicy {
  id: string;
  name: string;
  use_socks5: number | null;
  supports_models_endpoint: boolean | null;
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
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        SOCKS5 Proxy
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        Route upstream requests through a SOCKS5 proxy to hide the
        server&apos;s exit IP. Useful when deployed on VPS with datacenter IPs.
      </p>

      <div className="rounded-widget border border-border/40 bg-secondary/50 p-4 space-y-4">
        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Enable SOCKS5 Proxy</span>
          </div>
          <div className="flex items-center gap-2">
            {data.enabled && (
              <span
                className={`text-xs ${data.bridgeStatus === "running" ? "text-green-500" : "text-red-500"}`}
              >
                Bridge: {data.bridgeStatus}
              </span>
            )}
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={saving}
            />
          </div>
        </div>

        {/* Connection settings */}
        <div className="rounded border border-border/30 bg-background/50 p-3 space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Connection
          </p>

          <div className="grid grid-cols-[1fr_100px] gap-2">
            <div>
              <Label className="text-xs">Host</Label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="proxy.example.com"
                className="h-8 text-xs font-mono"
                disabled={saving}
              />
            </div>
            <div>
              <Label className="text-xs">Port</Label>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="1080"
                type="number"
                className="h-8 text-xs font-mono"
                disabled={saving}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">
                Username{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                className="h-8 text-xs font-mono"
                disabled={saving}
              />
            </div>
            <div>
              <Label className="text-xs">
                Password{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <div className="flex gap-1">
                <Input
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
                      className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={handleClearPassword}
                      disabled={saving}
                    >
                      <XCircle className="h-3 w-3" />
                    </Button>
                  )}
              </div>
              {passwordState === "cleared" && (
                <p className="text-xs text-amber-500 mt-0.5">
                  Password will be cleared on save
                </p>
              )}
            </div>
          </div>

          {/* Test button */}
          <div className="flex items-center gap-2">
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
                className={`text-xs flex items-center gap-1 ${testResult.success ? "text-green-500" : "text-red-500"}`}
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
        </div>

        {/* Upstream routing */}
        <div className="rounded border border-border/30 bg-background/50 p-3 space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Upstream Routing
          </p>
          <p className="text-xs text-muted-foreground">
            Default: Copilot &amp; GitHub = proxied, Custom providers = direct.
          </p>

          {/* Copilot policy */}
          <div className="flex items-center justify-between">
            <span className="text-sm">GitHub Copilot</span>
            <Select value={copilotPolicy} onValueChange={(v) => setCopilotPolicy(v as "default" | "on" | "off")}>
              <SelectTrigger className="w-[160px] h-8 text-xs">
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
            <div className="border-t border-border/30 pt-2 space-y-2">
              {providerPolicies.map((p) => (
                <div key={p.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{p.name}</span>
                    {p.use_socks5 === 1 &&
                      p.supports_models_endpoint === false && (
                        <span className="text-xs text-amber-500 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Re-probe needed
                        </span>
                      )}
                  </div>
                  <Select
                    value={String(p.use_socks5 ?? "null")}
                    onValueChange={(v) => handleProviderPolicyChange(p.id, v)}
                  >
                    <SelectTrigger className="w-[160px] h-8 text-xs">
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
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Save button */}
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="h-8 text-xs"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
            ) : null}
            Save
          </Button>
        </div>
      </div>
    </section>
  );
}

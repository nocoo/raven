"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Shield, Plus, Trash2, Loader2, AlertTriangle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { IPWhitelistInfo } from "@/lib/types";

interface IPWhitelistContentProps {
  data: IPWhitelistInfo;
}

export function IPWhitelistContent({ data }: IPWhitelistContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [trustProxy, setTrustProxy] = useState(data.trust_proxy);
  const [ranges, setRanges] = useState<string[]>(data.ranges);
  const [newRange, setNewRange] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "ip_whitelist_enabled",
            value: String(checked),
          }),
        });
        if (res.ok) {
          setEnabled(checked);
          router.refresh();
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? body?.error ?? "Failed to save");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  const handleTrustProxyToggle = useCallback(
    async (checked: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "ip_whitelist_trust_proxy",
            value: String(checked),
          }),
        });
        if (res.ok) {
          setTrustProxy(checked);
          router.refresh();
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? body?.error ?? "Failed to save");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  const saveRanges = useCallback(
    async (newRanges: string[]) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "ip_whitelist_ranges",
            value: JSON.stringify(newRanges),
          }),
        });
        if (res.ok) {
          setRanges(newRanges);
          router.refresh();
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? body?.error ?? "Failed to save");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [router]
  );

  const handleAddRange = useCallback(() => {
    const trimmed = newRange.trim();
    if (!trimmed) return;
    if (ranges.includes(trimmed)) {
      setError("This range already exists");
      return;
    }
    setNewRange("");
    saveRanges([...ranges, trimmed]);
  }, [newRange, ranges, saveRanges]);

  const handleRemoveRange = useCallback(
    (index: number) => {
      const newRanges = ranges.filter((_, i) => i !== index);
      saveRanges(newRanges);
    },
    [ranges, saveRanges]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddRange();
      }
    },
    [handleAddRange]
  );

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        IP Whitelist
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        Restrict access to the proxy by client IP address. Non-whitelisted IPs
        receive a silent 403 response.
      </p>

      <div className="rounded-widget border border-border/30 bg-secondary/50 p-4 space-y-4">
        {/* Enable/Disable toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Enable IP whitelist</span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>

        {/* Trust proxy toggle */}
        <div className="rounded border border-border/30 bg-background/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium cursor-pointer">
                Trust proxy headers
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Read client IP from X-Forwarded-For / X-Real-IP headers.
                Only enable if behind a trusted reverse proxy (nginx, Cloudflare, etc).
              </p>
            </div>
            <Switch
              checked={trustProxy}
              onCheckedChange={handleTrustProxyToggle}
              disabled={saving}
            />
          </div>
          {trustProxy && (
            <div className="flex items-start gap-2 text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <p className="text-xs">
                Warning: When enabled, clients can spoof their IP via headers
                unless your proxy strips and rewrites them.
              </p>
            </div>
          )}
        </div>

        {/* IP ranges list */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Supported formats: single IP (192.168.1.1), CIDR (192.168.1.0/24),
            or range (192.168.1.1-192.168.1.100)
          </p>

          {/* Existing ranges */}
          {ranges.length > 0 && (
            <div className="space-y-1.5">
              {ranges.map((range, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 rounded border border-border/30 bg-background/50 px-3 py-1.5"
                >
                  <code className="flex-1 text-xs font-mono">{range}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => handleRemoveRange(index)}
                    disabled={saving}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add new range */}
          <div className="flex items-center gap-2">
            <Input
              value={newRange}
              onChange={(e) => setNewRange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., 192.168.1.0/24"
              className="flex-1 h-8 text-xs font-mono"
              disabled={saving}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddRange}
              disabled={saving || !newRange.trim()}
              className="h-8 px-3 text-xs"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              <span className="ml-1.5">Add</span>
            </Button>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Anti-lockout notice */}
        <div className="text-xs text-muted-foreground border-t border-border/30 pt-3">
          <p className="font-medium mb-1">Anti-lockout behavior:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-1">
            <li>If no ranges are configured, all IPs are allowed</li>
            <li>If client IP cannot be determined, access is allowed</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

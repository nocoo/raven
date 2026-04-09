"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Shield, Plus, Trash2, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IPWhitelistInfo } from "@/lib/types";

interface IPWhitelistContentProps {
  data: IPWhitelistInfo;
}

export function IPWhitelistContent({ data }: IPWhitelistContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
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
        Restrict access to the proxy by client IP address. When enabled, only
        requests from whitelisted IPs will be accepted. Others are silently
        rejected.
      </p>

      <div className="rounded-widget border border-border/40 bg-secondary/50 p-4 space-y-4">
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

        {/* Warning when enabled but no ranges */}
        {enabled && ranges.length === 0 && (
          <p className="text-xs text-amber-500">
            Warning: Whitelist is enabled but no IP ranges are configured. All
            requests will be allowed until you add at least one range.
          </p>
        )}
      </div>
    </section>
  );
}

"use client";





import type { IPWhitelistInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Switch, LayerCard } from "@nocoo/basalt";
import {
  SettingAddRow,
  SettingListItem,
  SettingNote,
  SettingToggleRow,
  SettingsCard,
  SettingsSection,
} from "./settings-ui";

interface IPWhitelistContentProps {
  data: IPWhitelistInfo;
}

export function IPWhitelistContent({ data }: IPWhitelistContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [expanded, setExpanded] = useState(data.enabled || data.ranges.length > 0);
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
          if (checked) setExpanded(true);
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

  return (
    <SettingsSection
      title="IP Whitelist"
      hint="Restrict access to the proxy by client IP. Non-whitelisted IPs receive a silent 403."
    >
      <SettingsCard
        title="Restrict client IPs"
        action={<Switch aria-label="Restrict client IPs" checked={enabled} onCheckedChange={handleToggle} disabled={saving} />}
      >
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger className="w-full justify-between text-xs">Allowed IPs · {ranges.length}</CollapsibleTrigger>
          <CollapsibleContent unstyled><div className="space-y-3 pt-3">
        <div className="space-y-2">
          <SettingNote>Single IP, CIDR, or IP range.</SettingNote>
          {ranges.length > 0 && <div className="space-y-1.5">{ranges.map((range, index) => <SettingListItem key={range} value={range} onRemove={() => handleRemoveRange(index)} disabled={saving} />)}</div>}
          <SettingAddRow value={newRange} onChange={setNewRange} onAdd={handleAddRange} placeholder="e.g., 192.168.1.0/24" disabled={saving} saving={saving} />
        </div>
        <LayerCard.Well className="space-y-2 rounded-widget p-3">
          <SettingToggleRow
            id="ip-trust-proxy"
            label="Trust proxy headers"
            description="Read client IP from X-Forwarded-For / X-Real-IP. Only enable behind a trusted reverse proxy."
            checked={trustProxy}
            onCheckedChange={handleTrustProxyToggle}
            disabled={saving}
          />
          {trustProxy && (
            <div className="flex items-start gap-2 text-basalt-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p className="text-xs">
                Clients can spoof their IP via headers unless your proxy strips and rewrites them.
              </p>
            </div>
          )}
        </LayerCard.Well>

        <SettingNote>
          Empty list or unknown client IP allows access.
        </SettingNote>
          </div></CollapsibleContent>
        </Collapsible>
        {error ? <p role="alert" className="text-xs text-basalt-destructive">{error}</p> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

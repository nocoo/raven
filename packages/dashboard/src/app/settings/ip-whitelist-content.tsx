"use client";





import type { IPWhitelistInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Switch, LayerCard } from "@nocoo/basalt";
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

  return (
    <SettingsSection
      title="IP Whitelist"
      hint="Restrict access to the proxy by client IP. Non-whitelisted IPs receive a silent 403."
    >
      <SettingsCard
        title="Enable"
        action={<Switch checked={enabled} onCheckedChange={handleToggle} disabled={saving} />}
      >
        <LayerCard.Well className="space-y-2">
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

        <div className="space-y-2">
          <SettingNote>
            Formats: single IP (192.168.1.1), CIDR (192.168.1.0/24), or range
            (192.168.1.1-192.168.1.100)
          </SettingNote>
          {ranges.length > 0 && (
            <div className="space-y-1.5">
              {ranges.map((range, index) => (
                <SettingListItem
                  key={range}
                  value={range}
                  onRemove={() => handleRemoveRange(index)}
                  disabled={saving}
                />
              ))}
            </div>
          )}
          <SettingAddRow
            value={newRange}
            onChange={setNewRange}
            onAdd={handleAddRange}
            placeholder="e.g., 192.168.1.0/24"
            disabled={saving}
            saving={saving}
          />
        </div>

        {error ? <p className="text-xs text-basalt-destructive">{error}</p> : null}

        <SettingNote>
          <p className="mb-1 font-medium">Anti-lockout:</p>
          <ul className="ml-1 list-inside list-disc space-y-0.5">
            <li>If no ranges are configured, all IPs are allowed</li>
            <li>If client IP cannot be determined, access is allowed</li>
          </ul>
        </SettingNote>
      </SettingsCard>
    </SettingsSection>
  );
}

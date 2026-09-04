"use client";




import type { CorsInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Switch } from "@nocoo/basalt";
import {
  SettingAddRow,
  SettingListItem,
  SettingNote,
  SettingsCard,
  SettingsSection,
} from "./settings-ui";

interface CorsContentProps {
  data: CorsInfo;
}

export function CorsContent({ data }: CorsContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [origins, setOrigins] = useState<string[]>(data.allowed_origins);
  const [newOrigin, setNewOrigin] = useState("");
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
            key: "cors_enabled",
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

  const saveOrigins = useCallback(
    async (newOrigins: string[]) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "cors_allowed_origins",
            value: JSON.stringify(newOrigins),
          }),
        });
        if (res.ok) {
          setOrigins(newOrigins);
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

  const handleAddOrigin = useCallback(() => {
    const trimmed = newOrigin.trim();
    if (!trimmed) return;
    let normalized: string;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        setError("Invalid URL — must be http:// or https://");
        return;
      }
      normalized = url.origin;
    } catch {
      setError("Invalid URL — must be http:// or https://");
      return;
    }
    if (origins.includes(normalized)) {
      setError("This origin already exists");
      return;
    }
    setNewOrigin("");
    saveOrigins([...origins, normalized]);
  }, [newOrigin, origins, saveOrigins]);

  const handleRemoveOrigin = useCallback(
    (index: number) => {
      const newOrigins = origins.filter((_, i) => i !== index);
      saveOrigins(newOrigins);
    },
    [origins, saveOrigins]
  );

  return (
    <SettingsSection
      title="CORS"
      hint="Control which origins can make cross-origin requests to the proxy."
    >
      <SettingsCard
        title="Enable"
        action={<Switch checked={enabled} onCheckedChange={handleToggle} disabled={saving} />}
      >
        <div className="space-y-2">
          <SettingNote>
            Add allowed origins (e.g., http://localhost:3000, https://app.example.com)
          </SettingNote>
          {origins.length > 0 && (
            <div className="space-y-1.5">
              {origins.map((origin, index) => (
                <SettingListItem
                  key={origin}
                  value={origin}
                  onRemove={() => handleRemoveOrigin(index)}
                  disabled={saving}
                />
              ))}
            </div>
          )}
          <SettingAddRow
            value={newOrigin}
            onChange={setNewOrigin}
            onAdd={handleAddOrigin}
            placeholder="e.g., http://localhost:3000"
            disabled={saving}
            saving={saving}
          />
        </div>

        {error ? <p className="text-xs text-basalt-destructive">{error}</p> : null}

        <SettingNote>
          When disabled or the allowed origins list is empty, all origins are allowed.
        </SettingNote>
      </SettingsCard>
    </SettingsSection>
  );
}

"use client";




import type { CorsInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Switch } from "@nocoo/basalt";
import {
  SettingAddRow,
  SettingListItem,
  SettingNote,
  SettingsCard,
} from "./settings-ui";

interface CorsContentProps {
  data: CorsInfo;
}

export function CorsContent({ data }: CorsContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [expanded, setExpanded] = useState(data.enabled || data.allowed_origins.length > 0);
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
      <SettingsCard
        title="CORS"
        icon={Globe}
        tone="blue"
        action={<Switch aria-label="Restrict browser origins" checked={enabled} onCheckedChange={handleToggle} disabled={saving} />}
      >
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger className="w-full justify-between text-xs">Allowed origins · {origins.length}</CollapsibleTrigger>
          <CollapsibleContent unstyled><div className="space-y-3 pt-3">
        <div className="space-y-2">
          <SettingNote>
            Add an http:// or https:// origin.
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
          </div></CollapsibleContent>
        </Collapsible>
        {enabled && origins.length === 0 && <SettingNote>Empty list allows all origins.</SettingNote>}
        {error ? <p role="alert" className="text-xs text-basalt-destructive">{error}</p> : null}
      </SettingsCard>
  );
}

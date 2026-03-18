"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Save, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { SettingsData, SettingInfo } from "@/lib/types";

// ── Display config ──

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  vscode_version: {
    label: "VS Code Version",
    description: "Used in editor-version header for Copilot API requests",
  },
  copilot_chat_version: {
    label: "Copilot Chat Version",
    description:
      "Used in editor-plugin-version and user-agent headers for Copilot API requests",
  },
};

/** Version setting keys to render (excludes optimizations). */
const VERSION_KEYS = ["vscode_version", "copilot_chat_version"] as const;

const FALLBACK_BADGE = { label: "Fallback", className: "bg-warning/15 text-warning border-warning/20" };

const SOURCE_VARIANTS: Record<string, { label: string; className: string }> = {
  override: { label: "Override", className: "bg-info/15 text-info border-info/20" },
  local: { label: "Local", className: "bg-success/15 text-success border-success/20" },
  aur: { label: "AUR", className: "bg-purple/15 text-purple border-purple/20" },
  fallback: FALLBACK_BADGE,
};

// ── Component ──

interface SettingsContentProps {
  data: SettingsData;
}

export function SettingsContent({ data }: SettingsContentProps) {
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        Version Overrides
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        These versions are sent in HTTP headers when communicating with GitHub
        Copilot. Values are auto-detected from your local VS Code installation.
        Set an override to pin a specific version.
      </p>
      <div className="grid gap-3">
        {VERSION_KEYS.map((key) => {
          const info = data[key];
          if (!info) return null;
          return <SettingRow key={key} settingKey={key} info={info} />;
        })}
      </div>
    </section>
  );
}

// ── Setting row ──

function SettingRow({
  settingKey,
  info,
}: {
  settingKey: string;
  info: SettingInfo;
}) {
  const router = useRouter();
  const [value, setValue] = useState(info.override ?? info.effective);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = SETTING_LABELS[settingKey] ?? {
    label: settingKey,
    description: "",
  };
  const sourceBadge = SOURCE_VARIANTS[info.source] ?? FALLBACK_BADGE;

  const hasOverride = info.override !== null;
  const isDirty = value !== (info.override ?? info.effective);

  const handleSave = useCallback(async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: settingKey, value: value.trim() }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const body = await res.json().catch(() => null);
        const msg =
          body?.error?.message ?? body?.error ?? `Save failed (${res.status})`;
        setError(msg);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }, [settingKey, value, router]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/${settingKey}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const updated = await res.json();
        const newInfo = updated[settingKey] as SettingInfo | undefined;
        if (newInfo) {
          setValue(newInfo.effective);
        }
        router.refresh();
      } else {
        const body = await res.json().catch(() => null);
        const msg =
          body?.error?.message ?? body?.error ?? `Reset failed (${res.status})`;
        setError(msg);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setResetting(false);
    }
  }, [settingKey, router]);

  return (
    <div className="rounded-widget border border-border/40 bg-secondary/50 p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{meta.label}</span>
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 font-normal ${sourceBadge.className}`}
            >
              {sourceBadge.label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {meta.description}
          </p>
        </div>
        <code className="text-xs font-mono text-muted-foreground shrink-0 bg-muted px-2 py-1 rounded">
          {info.effective}
        </code>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder={info.effective}
          className="h-8 text-xs font-mono max-w-60"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleSave}
          disabled={saving || !isDirty || !value.trim()}
          className="h-8 px-3 text-xs"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          <span className="ml-1.5">Save</span>
        </Button>
        {hasOverride && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleReset}
            disabled={resetting}
            className="h-8 px-3 text-xs text-muted-foreground"
          >
            {resetting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            <span className="ml-1.5">Reset</span>
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive mt-2">{error}</p>
      )}
    </div>
  );
}

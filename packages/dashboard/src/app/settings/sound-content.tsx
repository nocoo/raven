"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Volume2, Play, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SoundInfo } from "@/lib/types";

interface SoundContentProps {
  data: SoundInfo;
}

export function SoundContent({ data }: SoundContentProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.enabled);
  const [soundName, setSoundName] = useState(data.sound_name);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "sound_enabled", value: String(checked) }),
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

  const handleSoundChange = useCallback(
    async (value: string) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "sound_name", value }),
        });
        if (res.ok) {
          setSoundName(value);
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

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch("/api/sound/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: soundName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? body?.error ?? "Failed to play");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setPreviewing(false);
    }
  }, [soundName]);

  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">
        Sound Notifications
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        Play a sound when the proxy encounters an error. Useful for noticing
        issues when you&apos;re not actively watching the logs.
      </p>

      <div className="rounded-widget border border-border/40 bg-secondary/50 p-4 space-y-4">
        {/* Enable/Disable toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Enable error sounds</span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>

        {/* Sound selection + preview */}
        <div className="flex items-center gap-3">
          <Select
            value={soundName}
            onValueChange={handleSoundChange}
            disabled={saving}
          >
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue placeholder="Select sound" />
            </SelectTrigger>
            <SelectContent>
              {data.available_sounds.map((sound) => (
                <SelectItem key={sound} value={sound} className="text-xs">
                  {sound}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            variant="outline"
            onClick={handlePreview}
            disabled={previewing}
            className="h-8 px-3 text-xs"
          >
            {previewing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            <span className="ml-1.5">Preview</span>
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </section>
  );
}

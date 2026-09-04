"use client";




import type { CorsInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Globe, Plus, Trash2, Loader2 } from "lucide-react";
import { Button, Input, LayerCard, Switch } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddOrigin();
      }
    },
    [handleAddOrigin]
  );

  return (
    <SectionRule title="CORS Allowed Origins">
      <p className="text-xs text-basalt-muted-foreground mb-4">
        Control which origins can make cross-origin requests to the proxy.
      </p>

      <LayerCard>
        <LayerCard.Header className="items-center">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-basalt-muted-foreground" />
            <span className="text-sm font-semibold text-basalt-foreground">Enable CORS restrictions</span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </LayerCard.Header>
        <LayerCard.Body className="space-y-4">
        {/* Origins list */}
        <div className="space-y-2">
          <p className="text-xs text-basalt-muted-foreground">
            Add allowed origins (e.g., http://localhost:3000, https://app.example.com)
          </p>

          {/* Existing origins */}
          {origins.length > 0 && (
            <div className="space-y-1.5">
              {origins.map((origin, index) => (
                <LayerCard.Well
                  key={origin}
                  className="flex items-center gap-2"
                >
                  <code className="flex-1 text-xs font-mono">{origin}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-basalt-muted-foreground hover:text-basalt-destructive"
                    onClick={() => handleRemoveOrigin(index)}
                    disabled={saving}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </LayerCard.Well>
              ))}
            </div>
          )}

          {/* Add new origin */}
          <div className="flex items-center gap-2">
            <Input
              value={newOrigin}
              onChange={(e) => setNewOrigin(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., http://localhost:3000"
              className="flex-1 h-8 text-xs font-mono"
              disabled={saving}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAddOrigin}
              disabled={saving || !newOrigin.trim()}
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

        {error && <p className="text-xs text-basalt-destructive">{error}</p>}

        {/* Info notice */}
        <div className="text-xs text-basalt-muted-foreground border-t border-basalt-border/30 pt-3">
          <p>
            When disabled or the allowed origins list is empty, all origins are
            allowed (default behavior).
          </p>
        </div>
        </LayerCard.Body>
      </LayerCard>
    </SectionRule>
  );
}

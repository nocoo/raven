"use client";



import type { OptimizationInfo } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Switch, Label, LayerCard } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";

// ── Optimization item definitions ──

const OPTIMIZATION_ITEMS: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  {
    id: "sanitize_orphaned_tool_results",
    label: "Sanitize Orphaned Tool Results",
    description:
      "Drop tool_result blocks referencing non-existent tool_use IDs after client-side compaction.",
  },
  {
    id: "reorder_tool_results",
    label: "Reorder Tool Results",
    description:
      "Reorder parallel tool results to match the tool_calls array order expected by upstream.",
  },
  {
    id: "filter_whitespace_chunks",
    label: "Filter Whitespace-Only Chunks",
    description:
      "Skip streaming chunks with whitespace-only content that cause blank lines in some clients.",
  },
];

// ── Component ──

interface OptimizationsContentProps {
  data: Record<string, OptimizationInfo>;
}

export function OptimizationsContent({ data }: OptimizationsContentProps) {
  return (
    <SectionRule title="Optimizations">
      <p className="text-xs text-basalt-muted-foreground mb-4">
        Protocol-level fixes from upstream compatibility research. Enable
        individually as needed.
      </p>
      <div className="grid gap-3">
        {OPTIMIZATION_ITEMS.map((item) => {
          const info = data[item.id];
          if (!info) return null;
          return (
            <OptimizationRow
              key={item.id}
              item={item}
              info={info}
            />
          );
        })}
      </div>
    </SectionRule>
  );
}

// ── Optimization row ──

function OptimizationRow({
  item,
  info,
}: {
  item: (typeof OPTIMIZATION_ITEMS)[number];
  info: OptimizationInfo;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(info.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      setEnabled(checked);
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: info.key,
            value: checked ? "true" : "false",
          }),
        });
        if (res.ok) {
          router.refresh();
        } else {
          // Revert on failure
          setEnabled(!checked);
          const body = await res.json().catch(() => null);
          const msg =
            body?.error?.message ??
            body?.error ??
            `Save failed (${res.status})`;
          setError(msg);
        }
      } catch (err) {
        setEnabled(!checked);
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
    [info.key, router],
  );

  return (
    <LayerCard>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label
            htmlFor={`opt-${item.id}`}
            className="text-sm font-medium cursor-pointer"
          >
            {item.label}
          </Label>
          <p className="text-xs text-basalt-muted-foreground mt-0.5">
            {item.description}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && <Loader2 className="h-3 w-3 animate-spin text-basalt-muted-foreground" />}
          <Switch
            id={`opt-${item.id}`}
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>
      </div>
      {error && (
        <p className="text-xs text-basalt-destructive mt-2">{error}</p>
      )}
    </LayerCard>
  );
}

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";

const STATUSES = ["success", "error"];
const FORMATS = ["anthropic", "openai"];

interface FiltersProps {
  models: string[];
}

export function Filters({ models }: FiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentModel = searchParams.get("model") ?? "";
  const currentStatus = searchParams.get("status") ?? "";
  const currentFormat = searchParams.get("format") ?? "";

  const setFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      // Reset pagination when filtering
      params.delete("cursor");
      params.delete("offset");
      router.push(`/?${params.toString()}`);
    },
    [router, searchParams],
  );

  const clearFilters = useCallback(() => {
    router.push("/");
  }, [router]);

  const hasFilters = currentModel || currentStatus || currentFormat;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Model filter */}
      <select
        value={currentModel}
        onChange={(e) => setFilter("model", e.target.value)}
        className="h-8 rounded-widget border bg-background px-2 text-sm text-foreground"
      >
        <option value="">All models</option>
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      {/* Status filter */}
      <select
        value={currentStatus}
        onChange={(e) => setFilter("status", e.target.value)}
        className="h-8 rounded-widget border bg-background px-2 text-sm text-foreground"
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Format filter */}
      <select
        value={currentFormat}
        onChange={(e) => setFilter("format", e.target.value)}
        className="h-8 rounded-widget border bg-background px-2 text-sm text-foreground"
      >
        <option value="">All formats</option>
        {FORMATS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>

      {hasFilters && (
        <Button variant="ghost" size="xs" onClick={clearFilters}>
          Clear
        </Button>
      )}
    </div>
  );
}

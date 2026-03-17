"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
      // "__all__" is the sentinel for "no filter"
      const resolved = value === "__all__" ? "" : value;
      if (resolved) {
        params.set(key, resolved);
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
    const params = new URLSearchParams(searchParams.toString());
    params.delete("model");
    params.delete("status");
    params.delete("format");
    params.delete("cursor");
    params.delete("offset");
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : "/");
  }, [router, searchParams]);

  const hasFilters = currentModel || currentStatus || currentFormat;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Model filter */}
      <Select value={currentModel || "__all__"} onValueChange={(v) => setFilter("model", v)}>
        <SelectTrigger size="sm" className="text-xs min-w-[140px]">
          <SelectValue placeholder="All models" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All models</SelectItem>
          {models.filter(Boolean).map((m) => (
            <SelectItem key={m} value={m}>{m}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Status filter */}
      <Select value={currentStatus || "__all__"} onValueChange={(v) => setFilter("status", v)}>
        <SelectTrigger size="sm" className="text-xs min-w-[120px]">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All statuses</SelectItem>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Format filter */}
      <Select value={currentFormat || "__all__"} onValueChange={(v) => setFilter("format", v)}>
        <SelectTrigger size="sm" className="text-xs min-w-[120px]">
          <SelectValue placeholder="All formats" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All formats</SelectItem>
          {FORMATS.map((f) => (
            <SelectItem key={f} value={f}>{f}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button variant="ghost" size="xs" onClick={clearFilters}>
          Clear
        </Button>
      )}
    </div>
  );
}

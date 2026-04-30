"use client";

import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { filterLabel } from "@/lib/analytics-filters";

interface FilterChipProps {
  filterKey: string;
  value: string | number | boolean;
  onRemove: () => void;
}

export function FilterChip({ filterKey, value, onRemove }: FilterChipProps) {
  const label = filterLabel(filterKey);
  const displayValue = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);

  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[120px] truncate">{displayValue}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:bg-accent hover:text-accent-foreground transition-colors"
        aria-label={`Remove ${label} filter`}
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}

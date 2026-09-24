"use client";


import { filterLabel } from "@/lib/analytics-filters";
import { X } from "lucide-react";
import { Badge, Button } from "@nocoo/basalt";

interface FilterChipProps {
  filterKey: string;
  value: string | number | boolean;
  displayValue?: string | undefined;
  onRemove: () => void;
}

export function FilterChip({ filterKey, value, displayValue, onRemove }: FilterChipProps) {
  const label = filterLabel(filterKey);
  const text = displayValue ?? (typeof value === "boolean" ? (value ? "Yes" : "No") : String(value));

  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal">
      <span className="text-basalt-muted-foreground">{label}:</span>
      <span className="max-w-40 truncate" title={String(value)}>{text}</span>
      <Button
        variant="ghost"
        size="icon"
        type="button"
        onClick={onRemove}
        className="ml-0.5 size-5 rounded-full p-0.5"
        aria-label={`Remove ${label} filter`}
      >
        <X className="size-3" />
      </Button>
    </Badge>
  );
}

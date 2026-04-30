"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { Filter, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TimeRangePicker } from "./time-range-picker";
import { FilterChip } from "./filter-chip";
import {
  searchParamsToFilters,
  filtersToSearchParams,
  countActiveFilters,
  DEFAULT_FILTERS,
  type AnalyticsFilters,
  type TimeRange,
} from "@/lib/analytics-filters";

const STATUS_OPTIONS = ["success", "error"];
const STREAM_OPTIONS = [
  { value: "true", label: "Streaming" },
  { value: "false", label: "Synchronous" },
];

interface FilterBarProps {
  /** Available model names for the filter dropdown */
  models?: string[];
  /** Available strategy names for the filter dropdown */
  strategies?: string[];
  /** Available upstream names for the filter dropdown */
  upstreams?: string[];
  /** Show fewer filters (compact mode for sub-pages) */
  compact?: boolean;
}

export function FilterBar({
  models = [],
  strategies = [],
  upstreams = [],
  compact = false,
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo(
    () => searchParamsToFilters(searchParams),
    [searchParams],
  );

  const activeCount = countActiveFilters(filters);

  const updateFilters = useCallback(
    (patch: Record<string, string | number | boolean | undefined>) => {
      // Build new filters, omitting keys with undefined values
      const base = { ...filters } as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          Reflect.deleteProperty(base, k);
        } else {
          base[k] = v;
        }
      }
      const next = base as unknown as AnalyticsFilters;
      const params = filtersToSearchParams(next);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  const setDimensionFilter = useCallback(
    (key: string, value: string) => {
      const resolved = value === "__all__" ? undefined : value;
      updateFilters({ [key]: resolved });
    },
    [updateFilters],
  );

  const removeDimensionFilter = useCallback(
    (key: string) => {
      updateFilters({ [key]: undefined });
    },
    [updateFilters],
  );

  const resetFilters = useCallback(() => {
    const params = filtersToSearchParams(DEFAULT_FILTERS);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }, [pathname, router]);

  const handleRangeChange = useCallback(
    (range: TimeRange) => {
      // Build a clean filter state — when switching to a preset, remove custom from/to
      const next: AnalyticsFilters = { ...filters, range };
      if (range !== "custom") {
        delete next.from;
        delete next.to;
      }
      const params = filtersToSearchParams(next);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, pathname, router],
  );

  // Collect active dimension chips (excluding range/from/to)
  const activeChips = useMemo(() => {
    const chips: { key: string; value: string | number | boolean }[] = [];
    if (filters.model) chips.push({ key: "model", value: filters.model });
    if (filters.resolved_model) chips.push({ key: "resolved_model", value: filters.resolved_model });
    if (filters.strategy) chips.push({ key: "strategy", value: filters.strategy });
    if (filters.upstream) chips.push({ key: "upstream", value: filters.upstream });
    if (filters.account) chips.push({ key: "account", value: filters.account });
    if (filters.client) chips.push({ key: "client", value: filters.client });
    if (filters.client_version) chips.push({ key: "client_version", value: filters.client_version });
    if (filters.session) chips.push({ key: "session", value: filters.session });
    if (filters.path) chips.push({ key: "path", value: filters.path });
    if (filters.status) chips.push({ key: "status", value: filters.status });
    if (filters.status_code !== undefined) chips.push({ key: "status_code", value: filters.status_code });
    if (filters.stream !== undefined) chips.push({ key: "stream", value: filters.stream });
    if (filters.has_error !== undefined) chips.push({ key: "has_error", value: filters.has_error });
    if (filters.min_latency !== undefined) chips.push({ key: "min_latency", value: `${filters.min_latency}ms` });
    if (filters.max_latency !== undefined) chips.push({ key: "max_latency", value: `${filters.max_latency}ms` });
    if (filters.stop_reason) chips.push({ key: "stop_reason", value: filters.stop_reason });
    if (filters.routing_path) chips.push({ key: "routing_path", value: filters.routing_path });
    return chips;
  }, [filters]);

  return (
    <div className="space-y-2">
      {/* Primary row: time range + dimension dropdowns */}
      <div className="flex flex-wrap items-center gap-2">
        <TimeRangePicker value={filters.range} onChange={handleRangeChange} />

        {!compact && (
          <>
            {/* Model filter */}
            {models.length > 0 && (
              <Select
                value={filters.model ?? "__all__"}
                onValueChange={(v) => setDimensionFilter("model", v)}
              >
                <SelectTrigger size="sm" className="text-xs min-w-[140px]">
                  <SelectValue placeholder="All models" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All models</SelectItem>
                  {models.filter(Boolean).map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Strategy filter */}
            {strategies.length > 0 && (
              <Select
                value={filters.strategy ?? "__all__"}
                onValueChange={(v) => setDimensionFilter("strategy", v)}
              >
                <SelectTrigger size="sm" className="text-xs min-w-[140px]">
                  <SelectValue placeholder="All strategies" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All strategies</SelectItem>
                  {strategies.filter(Boolean).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Upstream filter */}
            {upstreams.length > 0 && (
              <Select
                value={filters.upstream ?? "__all__"}
                onValueChange={(v) => setDimensionFilter("upstream", v)}
              >
                <SelectTrigger size="sm" className="text-xs min-w-[140px]">
                  <SelectValue placeholder="All upstreams" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All upstreams</SelectItem>
                  {upstreams.filter(Boolean).map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Status filter */}
            <Select
              value={filters.status ?? "__all__"}
              onValueChange={(v) => setDimensionFilter("status", v)}
            >
              <SelectTrigger size="sm" className="text-xs min-w-[120px]">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All statuses</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Stream filter */}
            <Select
              value={filters.stream === undefined ? "__all__" : String(filters.stream)}
              onValueChange={(v) => {
                if (v === "__all__") {
                  updateFilters({ stream: undefined });
                } else {
                  updateFilters({ stream: v === "true" });
                }
              }}
            >
              <SelectTrigger size="sm" className="text-xs min-w-[130px]">
                <SelectValue placeholder="All modes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All modes</SelectItem>
                {STREAM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        {/* Active filter count + reset */}
        {activeCount > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-muted-foreground">
              <Filter className="inline size-3 mr-0.5" />
              {activeCount} active
            </span>
            <Button variant="ghost" size="xs" onClick={resetFilters}>
              <RotateCcw className="size-3" />
              Reset
            </Button>
          </div>
        )}
      </div>

      {/* Active filter chips */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeChips.map((chip) => (
            <FilterChip
              key={chip.key}
              filterKey={chip.key}
              value={chip.value}
              onRemove={() => removeDimensionFilter(chip.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

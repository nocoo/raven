"use client";



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
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useTransition } from "react";
import { Filter, RefreshCw, RotateCcw } from "lucide-react";
import { Button, Input } from "@nocoo/basalt";
import { PROTOCOL_META, PROTOCOL_MODES } from "@/lib/monitor";
import { LocalTime } from "@/components/local-time";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nocoo/basalt/components/select";

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
  keys?: { id: string; label: string }[];
  investigation?: boolean;
  /** Show fewer filters (compact mode for sub-pages) */
  compact?: boolean;
}

export function FilterBar({
  models = [],
  strategies = [],
  upstreams = [],
  keys = [],
  investigation = false,
  compact = false,
}: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [refreshing, startRefresh] = useTransition();

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
    if (filters.key_id) chips.push({ key: "key_id", value: filters.key_id });
    if (filters.protocol_mode) chips.push({ key: "protocol_mode", value: filters.protocol_mode });
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
    <div className="w-full space-y-2">
      {/* Primary row: time range + dimension dropdowns */}
      <div className="flex flex-wrap items-center gap-2">
        <TimeRangePicker value={filters.range} onChange={handleRangeChange} />

        {!compact && (
          <>
            <Select value={filters.protocol_mode ?? "__all__"} onValueChange={(v) => setDimensionFilter("protocol_mode", v)}>
              <SelectTrigger size="sm" className="w-auto min-w-[140px] text-xs" aria-label="Filter by protocol"><SelectValue placeholder="All protocols" /></SelectTrigger>
              <SelectContent><SelectItem value="__all__">All protocols</SelectItem>{PROTOCOL_MODES.map(mode => <SelectItem key={mode} value={mode}>{PROTOCOL_META[mode].label}</SelectItem>)}</SelectContent>
            </Select>
            {keys.length > 0 && <Select value={filters.key_id ?? "__all__"} onValueChange={(v) => updateFilters({ key_id: v === "__all__" ? undefined : v, account: undefined })}>
              <SelectTrigger size="sm" className="w-auto min-w-[140px] max-w-64 text-xs" aria-label="Filter by API key"><SelectValue placeholder="All keys" /></SelectTrigger>
              <SelectContent><SelectItem value="__all__">All keys</SelectItem>{keys.map(key => <SelectItem key={key.id} value={key.id}>{key.label} · {key.id.startsWith("legacy:") ? "historical" : key.id.slice(-8)}</SelectItem>)}</SelectContent>
            </Select>}
            {/* Model filter */}
            {models.length > 0 && (
              <Select
                value={filters.model ?? "__all__"}
                onValueChange={(v) => setDimensionFilter("model", v)}
              >
                <SelectTrigger size="sm" className="w-auto text-xs min-w-[140px]" aria-label="Filter by model">
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
                <SelectTrigger size="sm" className="w-auto text-xs min-w-[140px]" aria-label="Filter by strategy">
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
                <SelectTrigger size="sm" className="w-auto text-xs min-w-[140px]" aria-label="Filter by upstream">
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
              <SelectTrigger size="sm" className="w-auto text-xs min-w-[120px]" aria-label="Filter by status">
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
              <SelectTrigger size="sm" className="w-auto text-xs min-w-[130px]" aria-label="Filter by stream">
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

        <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => startRefresh(() => router.refresh())} aria-label="Refresh monitoring data"><RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />Refresh</Button>

        {/* Active filter count + reset */}
        {activeCount > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-basalt-muted-foreground">
              <Filter className="inline size-3 mr-0.5" />
              {activeCount} active
            </span>
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              <RotateCcw className="size-3" />
              Reset
            </Button>
          </div>
        )}
      </div>

      {filters.range === "custom" && filters.from !== undefined && filters.to !== undefined && <p className="text-xs text-basalt-muted-foreground">Selected interval: <LocalTime timestamp={filters.from} /> – <LocalTime timestamp={filters.to} /></p>}

      {investigation && <details className="text-xs text-basalt-muted-foreground"><summary className="cursor-pointer py-1">Client & session filters</summary><form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        updateFilters({ client: String(values.get("client") ?? "").trim() || undefined, session: String(values.get("session") ?? "").trim() || undefined, upstream: String(values.get("upstream") ?? "").trim() || undefined });
      }}>
        <label htmlFor="monitor-client" className="space-y-1">Client<Input id="monitor-client" key={`client-${filters.client}`} name="client" aria-label="Client name" defaultValue={filters.client ?? ""} placeholder="Exact client name" className="h-8 w-44 text-xs" /></label>
        <label htmlFor="monitor-session" className="space-y-1">Session<Input id="monitor-session" key={`session-${filters.session}`} name="session" aria-label="Session ID" defaultValue={filters.session ?? ""} placeholder="Exact session ID" className="h-8 w-64 text-xs" /></label>
        <label htmlFor="monitor-upstream" className="space-y-1">Upstream<Input id="monitor-upstream" key={`upstream-${filters.upstream}`} name="upstream" aria-label="Upstream name" defaultValue={filters.upstream ?? ""} placeholder="Exact upstream name" className="h-8 w-44 text-xs" /></label>
        <Button type="submit" variant="outline" size="sm">Apply</Button>
      </form></details>}

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

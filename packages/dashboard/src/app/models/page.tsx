import { Suspense } from "react";
import { Boxes, Activity, Zap, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { StatCard } from "@/components/stats/stat-card";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { safeFetch } from "@/lib/proxy";
import { formatCompact, formatPercent } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { ModelExplorer } from "./model-explorer";

export const metadata = { title: "Models" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function ModelsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.msort ?? "count";
  const order = resolvedParams.morder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=model&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Models" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Model Explorer</h1>
            <p className="text-meta">Per-model traffic, latency, error rate and token usage.</p>
          </div>
          <FetchError title="Failed to load model stats" message={result.error} />
        </div>
      </AppShell>
    );
  }

  const models = result.data.map((e) => e.key).filter(Boolean);

  // Aggregate summary cards from existing BreakdownEntry data — no extra API call.
  const totalModels = result.data.length;
  const totalRequests = result.data.reduce((s, e) => s + e.count, 0);
  const totalTokens = result.data.reduce((s, e) => s + e.total_tokens, 0);
  const totalErrors = result.data.reduce(
    (s, e) => s + e.error_rate * e.count,
    0,
  );
  const avgErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

  return (
    <AppShell breadcrumbs={[{ label: "Models" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Model Explorer</h1>
          <p className="text-meta">Per-model traffic, latency, error rate and token usage.</p>
        </div>
        <Suspense>
          <FilterBar models={models} compact />
        </Suspense>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          <StatCard icon={Boxes} label="Total Models" value={formatCompact(totalModels)} />
          <StatCard icon={Activity} label="Total Requests" value={formatCompact(totalRequests)} />
          <StatCard icon={Zap} label="Total Tokens" value={formatCompact(totalTokens)} />
          <StatCard
            icon={AlertTriangle}
            label="Avg Error Rate"
            value={formatPercent(avgErrorRate)}
            accent={avgErrorRate > 0.1 ? "danger" : avgErrorRate > 0.05 ? "warning" : "default"}
          />
        </div>
        <ModelExplorer data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}

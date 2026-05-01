import { Suspense } from "react";
import { ListChecks, Activity, Zap, Clock } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { StatCard } from "@/components/stats/stat-card";
import { FetchError } from "@/components/fetch-error";
import { FilterBar } from "@/components/analytics/filter-bar";
import { safeFetch } from "@/lib/proxy";
import { formatCompact } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";
import {
  searchParamsToFilters,
  filtersToApiQuery,
} from "@/lib/analytics-filters";
import { SessionsTable } from "./sessions-table";

export const metadata = { title: "Sessions" };

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function SessionsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) urlParams.set(key, value);
  }

  const filters = searchParamsToFilters(urlParams);
  const apiQuery = filtersToApiQuery(filters);
  const sort = resolvedParams.ssort ?? "last_seen";
  const order = resolvedParams.sorder ?? "desc";

  const result = await safeFetch<BreakdownEntry[]>(
    `/api/stats/breakdown${apiQuery}${apiQuery ? "&" : "?"}by=session_id&sort=${sort}&order=${order}&limit=50`,
  );

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Sessions" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Sessions</h1>
            <p className="text-meta">Aggregate per-session activity grouped by session_id.</p>
          </div>
          <FetchError title="Failed to load session data" message={result.error} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Sessions" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Sessions</h1>
          <p className="text-meta">Aggregate per-session activity grouped by session_id.</p>
        </div>
        <Suspense>
          <FilterBar compact />
        </Suspense>
        {(() => {
          const totalSessions = result.data.length;
          const totalRequests = result.data.reduce((s, e) => s + e.count, 0);
          const totalTokens = result.data.reduce((s, e) => s + e.total_tokens, 0);
          // Avg session duration = mean of (last_seen - first_seen) per session.
          const avgDurationMs =
            totalSessions > 0
              ? result.data.reduce(
                  (s, e) => s + Math.max(0, e.last_seen - e.first_seen),
                  0,
                ) / totalSessions
              : 0;
          const formatDuration = (ms: number): string => {
            if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
            if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
            if (ms < 86_400_000) {
              const h = Math.floor(ms / 3_600_000);
              const m = Math.floor((ms % 3_600_000) / 60_000);
              return `${h}h ${m}m`;
            }
            return `${Math.floor(ms / 86_400_000)}d`;
          };
          return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
              <StatCard icon={ListChecks} label="Total Sessions" value={formatCompact(totalSessions)} />
              <StatCard icon={Activity} label="Total Requests" value={formatCompact(totalRequests)} />
              <StatCard icon={Zap} label="Total Tokens" value={formatCompact(totalTokens)} />
              <StatCard icon={Clock} label="Avg Session Duration" value={formatDuration(avgDurationMs)} />
            </div>
          );
        })()}
        <SessionsTable data={result.data} currentSort={sort} currentOrder={order} />
      </div>
    </AppShell>
  );
}

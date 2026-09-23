import type { MonitorData } from "@/lib/monitor-data";
import { monitorHref } from "@/lib/monitor";
import { TokenChart, TrafficChart } from "@/components/analytics/panels/monitor-charts";
import { InvestigationPanel, MonitorLink, ProtocolPanel, RankPanel } from "@/components/analytics/panels/monitor-panels";

export function AnalyticsCharts({ data }: { data: MonitorData }) {
  return <>
    <div className="grid grid-cols-1 gap-3 @min-[60rem]/page:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
      <TrafficChart data={data} />
      <ProtocolPanel data={data.protocols} summary={data.summary} filters={data.filters} />
    </div>
    <div className="grid grid-cols-1 gap-3 @min-[48rem]/page:grid-cols-2">
      <RankPanel title="Model footprint" description="Workload, latency, errors and native share in one view." data={data.models} dimension="model" filters={data.filters} action={<MonitorLink href={monitorHref("/models", data.filters)}>Models</MonitorLink>} />
      <RankPanel title="Key usage" description="Caller identity, volume and last activity." data={data.keys} dimension="key_id" filters={data.filters} action={<MonitorLink href={monitorHref("/keys", data.filters)}>API Keys</MonitorLink>} />
      <TokenChart data={data} />
      <InvestigationPanel summary={data.summary} filters={data.filters} clients={data.clients} upstreams={data.upstreams} />
    </div>
  </>;
}

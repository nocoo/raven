import { Badge } from "@nocoo/basalt";
import { formatMonitorTime, keyIdentity, keyLabel, monitorHref, type UsageDimension } from "@/lib/monitor";
import type { MonitorData } from "@/lib/monitor-data";
import { ActivityChart, TokenChart, TrafficChart } from "./monitor-charts";
import { InvestigationPanel, MonitorLink, MonitorPanel, ProtocolPanel, RankPanel } from "./monitor-panels";

export function UsageExplorer({ data, dimension }: { data: MonitorData; dimension: UsageDimension }) {
  const isKey = dimension === "key_id";
  const selected = data.filters[dimension];
  const entries = isKey ? data.keys : data.models;
  const current = entries.find(entry => entry.key === selected);
  return <>
    {selected && <MonitorPanel title={isKey ? keyLabel({ key: selected, account_name: current?.account_name ?? "" }) : selected} description={isKey ? keyIdentity(selected) : "Selected model · all charts below share the same filters"} action={<MonitorLink href={monitorHref(isKey ? "/keys" : "/models", data.filters, { [dimension]: undefined })}>All {isKey ? "keys" : "models"}</MonitorLink>}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-basalt-muted-foreground">
        {current && <><span>First in range {formatMonitorTime(current.first_seen)} UTC</span><span>Last in range {formatMonitorTime(current.last_seen)} UTC</span></>}
        {isKey && selected.startsWith("legacy:") && <Badge variant="warning" className="text-xs">Historical name group · may contain multiple keys</Badge>}
        <MonitorLink href={monitorHref("/requests", data.filters)}>Inspect matching requests</MonitorLink>
      </div>
    </MonitorPanel>}
    <ActivityChart data={data} dimension={dimension} />
    <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
      <RankPanel title={isKey ? "Key identities" : "Model comparison"} description={isKey ? "Select a key. Stable IDs keep same-name keys separate." : "Select a model. Compare demand, tail latency and native share."} data={entries} dimension={dimension} filters={data.filters} selected={selected} limit={50} />
      <div className="space-y-3">
        <RankPanel title={isKey ? "Models called" : "Calling keys"} description={selected ? "Activity for the selected identity and time range." : "Select a row on the left to narrow this distribution."} data={isKey ? data.models : data.keys} dimension={isKey ? "model" : "key_id"} filters={data.filters} limit={8} />
        <ProtocolPanel data={data.protocols} summary={data.summary} filters={data.filters} />
      </div>
    </div>
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2"><TokenChart data={data} /><InvestigationPanel summary={data.summary} filters={data.filters} clients={data.clients} upstreams={data.upstreams} /></div>
    {selected && <TrafficChart data={data} />}
  </>;
}

"use client";

import { Database } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nocoo/basalt/components/select";
import { useHistoryRetention } from "@/hooks/use-history-retention";
import { RETENTION_DAYS, type RetentionDays } from "../../../../proxy/src/core/history-retention";
import { SettingsCard } from "./settings-ui";

export function HistoryRetentionContent({ days }: { days: RetentionDays }) {
  const vm = useHistoryRetention(days);
  return <SettingsCard title="Request history" icon={Database} tone="teal" action={
    <Select value={String(vm.days)} onValueChange={vm.save} disabled={vm.saving}>
      <SelectTrigger aria-label="History retention" size="sm" loading={vm.saving} className="w-28"><SelectValue /></SelectTrigger>
      <SelectContent>{RETENTION_DAYS.map(value => <SelectItem key={value} value={String(value)}>{value} days</SelectItem>)}</SelectContent>
    </Select>
  }>
    <p className="text-xs text-basalt-muted-foreground">Older requests are permanently deleted every hour. Keys, routing and quota accounting are kept.</p>
    {vm.error && <p role="alert" className="text-xs text-basalt-destructive">{vm.error}</p>}
  </SettingsCard>;
}

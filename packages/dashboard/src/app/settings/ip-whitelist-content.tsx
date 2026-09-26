"use client";
import type { IPWhitelistInfo } from "@/lib/types";
import { ShieldCheck } from "lucide-react";
import { IPPolicyDialog } from "@/components/analytics/panels/ip-management";
import { SettingsCard, SettingNote } from "./settings-ui";

export function IPWhitelistContent({ data }: { data: IPWhitelistInfo }) {
  return <SettingsCard title="IP access" icon={ShieldCheck} tone="teal" action={<IPPolicyDialog />}>
    <SettingNote>{data.enabled ? `Whitelist · ${data.ranges.length} rules` : "Unrestricted"} · {data.trusted_proxies.length} trusted proxy rules</SettingNote>
  </SettingsCard>;
}

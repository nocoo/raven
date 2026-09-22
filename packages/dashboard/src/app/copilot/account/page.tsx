import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { CopilotUser } from "@/lib/types";
import { AccountContent } from "./account-content";
import { SentinelStatusPanel } from "@/app/sentinel-status-panel";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@nocoo/basalt";

export const metadata = { title: "Copilot Account" };

export default async function CopilotAccountPage() {
  const result = await safeFetch<CopilotUser>("/api/copilot/user");

  return (
    <div className="space-y-4">
      {result.ok
        ? <AccountContent data={result.data} />
        : <><PageHeader title="Account" description="GitHub Copilot subscription and quota." /><FetchError title="Failed to load account info" message={result.error} /></>}
      <Collapsible>
        <CollapsibleTrigger className="text-xs text-basalt-muted-foreground">Token refresh diagnostics</CollapsibleTrigger>
        <CollapsibleContent unstyled><div className="pt-4"><SentinelStatusPanel /></div></CollapsibleContent>
      </Collapsible>
    </div>
  );
}

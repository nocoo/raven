import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { CopilotUser } from "@/lib/types";
import { AccountContent } from "./account-content";
import { SentinelStatusPanel } from "@/app/sentinel-status-panel";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "Copilot Account" };

export default async function CopilotAccountPage() {
  const result = await safeFetch<CopilotUser>("/api/copilot/user");

  return (
    <AppShell breadcrumbs={[{ label: "Copilot" }, { label: "Account" }]}>
      <div className="space-y-4 md:space-y-6">
        <PageHeader title="Copilot Account" description="GitHub Copilot subscription, plan and quota for the proxied account." />
        {result.ok
          ? <AccountContent data={result.data} />
          : <FetchError title="Failed to load account info" message={result.error} />}
        <SentinelStatusPanel />
      </div>
    </AppShell>
  );
}

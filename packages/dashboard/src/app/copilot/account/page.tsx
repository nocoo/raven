import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { CopilotUser } from "@/lib/types";
import { AccountContent } from "./account-content";

export const metadata = { title: "Copilot Account" };

export default async function CopilotAccountPage() {
  const result = await safeFetch<CopilotUser>("/api/copilot/user");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Copilot" }, { label: "Account" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Copilot Account</h1>
            <p className="text-meta">GitHub Copilot subscription, plan and quota for the proxied account.</p>
          </div>
          <FetchError
            title="Failed to load account info"
            message={result.error}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Copilot" }, { label: "Account" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Copilot Account</h1>
          <p className="text-meta">GitHub Copilot subscription, plan and quota for the proxied account.</p>
        </div>
        <AccountContent data={result.data} />
      </div>
    </AppShell>
  );
}

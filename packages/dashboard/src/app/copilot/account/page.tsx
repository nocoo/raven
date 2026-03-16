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
        <div className="space-y-4">
          <h1 className="text-lg font-semibold font-display">Copilot Account</h1>
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
      <div className="space-y-4">
        <h1 className="text-lg font-semibold font-display">Copilot Account</h1>
        <AccountContent data={result.data} />
      </div>
    </AppShell>
  );
}

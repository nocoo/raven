import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { CopilotModelList } from "@/lib/types";
import { CopilotModelsContent } from "./models-content";

export const metadata = { title: "Copilot Models" };

export default async function CopilotModelsPage() {
  const result = await safeFetch<CopilotModelList>("/api/copilot/models");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Copilot" }, { label: "Models" }]}>
        <div className="space-y-4 md:space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-display">Copilot Models</h1>
            <p className="text-meta">All Copilot models exposed through the proxy with capabilities and limits.</p>
          </div>
          <FetchError
            title="Failed to load Copilot models"
            message={result.error}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Copilot" }, { label: "Models" }]}>
      <div className="space-y-4 md:space-y-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-display">Copilot Models</h1>
          <p className="text-meta">All Copilot models exposed through the proxy with capabilities and limits.</p>
        </div>
        <CopilotModelsContent data={result.data.data} />
      </div>
    </AppShell>
  );
}

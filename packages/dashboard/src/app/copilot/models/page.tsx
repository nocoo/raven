import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { CopilotModelList } from "@/lib/types";
import { CopilotModelsContent } from "./models-content";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export const metadata = { title: "Copilot Models" };

export default async function CopilotModelsPage() {
  const result = await safeFetch<CopilotModelList>("/api/copilot/models");

  if (!result.ok) {
    return (
      <div className="space-y-4">
        <PageHeader title="Models" description="Copilot models, capabilities and limits." />
        <FetchError
          title="Failed to load Copilot models"
          message={result.error}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Models" description="Copilot models, capabilities and limits." />
      <CopilotModelsContent data={result.data.data} />
    </div>
  );
}

import { AppShell } from "@/components/layout/app-shell";
import { FetchError } from "@/components/fetch-error";
import { safeFetch } from "@/lib/proxy";
import type { ModelStats } from "@/lib/types";
import { ModelsContent } from "./models-content";

export const metadata = { title: "Models" };

export default async function ModelsPage() {
  const result = await safeFetch<ModelStats[]>("/api/stats/models");

  if (!result.ok) {
    return (
      <AppShell breadcrumbs={[{ label: "Models" }]}>
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Model Statistics</h1>
          <FetchError
            title="Failed to load model stats"
            message={result.error}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Models" }]}>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Model Statistics</h1>
        <ModelsContent data={result.data} />
      </div>
    </AppShell>
  );
}

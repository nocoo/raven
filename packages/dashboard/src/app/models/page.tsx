import { AppShell } from "@/components/layout/app-shell";
import { proxyFetch } from "@/lib/proxy";
import type { ModelStats } from "@/lib/types";
import { ModelsContent } from "./models-content";

async function getModelStats(): Promise<ModelStats[]> {
  try {
    return await proxyFetch<ModelStats[]>("/api/stats/models");
  } catch {
    return [];
  }
}

export default async function ModelsPage() {
  const models = await getModelStats();

  return (
    <AppShell breadcrumbs={[{ label: "Models" }]}>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Model Statistics</h1>
        <ModelsContent data={models} />
      </div>
    </AppShell>
  );
}

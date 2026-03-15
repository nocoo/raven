import { AppShell } from "@/components/layout/app-shell";
import { LogsContent } from "./logs-content";

export default function LogsPage() {
  return (
    <AppShell breadcrumbs={[{ label: "Logs" }]}>
      <LogsContent />
    </AppShell>
  );
}

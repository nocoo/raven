import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { LogsContent } from "./logs-content";

export const metadata = { title: "Logs" };

export default function LogsPage() {
  return (
    <AppShell breadcrumbs={[{ label: "Logs" }]}>
      <Suspense>
        <LogsContent />
      </Suspense>
    </AppShell>
  );
}

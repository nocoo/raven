import { MonitorPage, type MonitorPageProps } from "@/components/analytics/panels/monitor-page";

export const metadata = { title: "Models" };

export default function ModelsPage(props: MonitorPageProps) {
  return <MonitorPage {...props} dimension="model" />;
}

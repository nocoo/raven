import { MonitorPage, type MonitorPageProps } from "@/components/analytics/panels/monitor-page";

export const metadata = { title: "API Keys" };

export default function KeysPage(props: MonitorPageProps) {
  return <MonitorPage {...props} dimension="key_id" />;
}

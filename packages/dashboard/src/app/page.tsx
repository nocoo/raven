import { MonitorPage, type MonitorPageProps } from "@/components/analytics/panels/monitor-page";

export const metadata = { title: "Overview" };

export default function HomePage(props: MonitorPageProps) {
  return <MonitorPage {...props} />;
}

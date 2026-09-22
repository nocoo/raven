"use client";

import { useSyncExternalStore } from "react";
import { formatMonitorTime } from "@/lib/monitor";

const subscribe = () => () => undefined;
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function LocalTime({ timestamp, precision = "minute" }: { timestamp: number; precision?: "day" | "minute" | "second" | "millisecond" }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const date = new Date(timestamp);
  return <time dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()}>{hydrated ? formatMonitorTime(timestamp, precision) : "—"}</time>;
}

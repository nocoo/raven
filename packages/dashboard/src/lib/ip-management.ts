import { fillActivity } from "./monitor";
import { routingRequest, jsonRequest } from "./routing-client";

export interface IPPolicy { enabled: boolean; ranges: string[]; trusted_proxies?: string[] }
export interface IPLocation {
  ip: string;
  location: { country?: string; countryCode?: string; province?: string; city?: string; isp?: string; asn?: number | null; asOrg?: string } | null;
  fetched_at: number;
  cached: boolean;
}
export const ipPolicyPath = (keyId?: string) => keyId ? `/api/keys/${encodeURIComponent(keyId)}/ip-policy` : "/api/ip-policy";
export function policyPayload(enabled: boolean, ranges: string, trusted?: string): IPPolicy {
  const lines = (value: string) => [...new Set(value.split("\n").map(line => line.trim()).filter(Boolean))];
  const entries = lines(ranges);
  if (enabled && !entries.length) throw new Error("Add at least one IP address or network before enabling the whitelist.");
  return { enabled, ranges: entries, ...(trusted === undefined ? {} : { trusted_proxies: lines(trusted) }) };
}
export const loadIPPolicy = (keyId?: string) => routingRequest<IPPolicy>(ipPolicyPath(keyId));
export const saveIPPolicy = (policy: IPPolicy, keyId?: string) => routingRequest<IPPolicy>(ipPolicyPath(keyId), jsonRequest("PUT", policy));
export const locateIP = (ip: string) => routingRequest<IPLocation>(`/api/ip-lookup?ip=${encodeURIComponent(ip)}`);

export function ipActivitySeries(data: import("./types").GroupedTimeseries, window: { from: number; to: number }, intervalMs: number) {
  const activity = fillActivity(data, window.from, window.to, intervalMs);
  const series = activity.keys.map((label, index) => ({ key: `ip${index}`, label }));
  const points: Array<{ x: number } & Record<string, number>> = activity.points.map(point => ({ x: point.bucket, ...Object.fromEntries(series.map(item => [item.key, point[item.label] ?? 0])) }));
  return { series, points };
}

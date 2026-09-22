import { localDateTime, toLocalWindows, toUtcWindows, utcDateTime, type LocalWindow } from "./routing-schedule";
import type { CreateProviderInput, ProviderPublic, QuotaPolicy, ScheduleMode, UpdateProviderInput } from "./routing-types";

export interface QuotaDraft {
  enabled: boolean;
  limit: string;
  window: string;
  reset: string;
  mode: ScheduleMode;
  windows: LocalWindow<number>[];
}
export interface UpstreamDraft {
  name: string;
  base_url: string;
  format: CreateProviderInput["format"];
  api_key: string;
  is_enabled: boolean;
  supports_reasoning: boolean;
  auth_style: "bearer" | "x-api-key" | null;
  use_socks5: boolean | null;
  manual: string;
  quota: QuotaDraft;
}

export function quotaDraft(quota: QuotaPolicy | null, offset: number, now: number): QuotaDraft {
  return {
    enabled: quota !== null,
    limit: String(quota?.limit_tokens ?? 100_000),
    window: String(quota?.window_minutes ?? 300),
    reset: localDateTime(quota?.next_reset_at ?? now + 300 * 60_000, offset),
    mode: quota?.mode ?? "all_day",
    windows: quota ? toLocalWindows(quota.multipliers.map(item => ({ ...item, value: item.multiplier })), quota.mode, offset) : [],
  };
}

export function upstreamDraft(upstream: ProviderPublic | null, offset: number, now: number): UpstreamDraft {
  return {
    name: upstream?.name ?? "", base_url: upstream?.base_url ?? "", format: upstream?.format ?? "chat_completions",
    api_key: "", is_enabled: upstream?.is_enabled ?? true, supports_reasoning: upstream?.supports_reasoning ?? false,
    auth_style: upstream?.auth_style ?? null, use_socks5: upstream?.use_socks5 ?? null,
    manual: upstream?.manual_models.join("\n") ?? "", quota: quotaDraft(upstream?.quota ?? null, offset, now),
  };
}

export function quotaPayload(draft: QuotaDraft, offset: number): QuotaPolicy | null {
  if (!draft.enabled) return null;
  const limit_tokens = Number(draft.limit);
  const window_minutes = Number(draft.window);
  const next_reset_at = utcDateTime(draft.reset, offset);
  if (!Number.isSafeInteger(limit_tokens) || limit_tokens <= 0) throw new Error("Token allowance must be a positive whole number.");
  if (!Number.isSafeInteger(window_minutes) || window_minutes <= 0) throw new Error("Window length must be a positive number of minutes.");
  if (!Number.isFinite(next_reset_at)) throw new Error("Choose a valid next reset date and time.");
  const windows = toUtcWindows(draft.windows, draft.mode, offset);
  if (windows.some(window => !Number.isFinite(window.value) || window.value <= 0)) throw new Error("Every multiplier must be greater than zero.");
  return { limit_tokens, window_minutes, next_reset_at, mode: draft.mode, multipliers: windows.map(window => ({ id: window.id, start_minute: window.start_minute, end_minute: window.end_minute, multiplier: window.value })) };
}

export function upstreamPayload(draft: UpstreamDraft, upstream: ProviderPublic | null, offset: number): UpdateProviderInput {
  const manual_models = [...new Set(draft.manual.split(/[\n,]+/).map(id => id.trim()).filter(Boolean))];
  if (manual_models.includes("auto")) throw new Error('"auto" is reserved for Raven and cannot be a manual model.');
  const quota = quotaPayload(draft.quota, offset);
  if (upstream?.kind === "copilot") return { manual_models, quota };
  if (!draft.name.trim()) throw new Error("Give this upstream a name.");
  let url: URL;
  try { url = new URL(draft.base_url); } catch { throw new Error("Enter an absolute HTTP or HTTPS base URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTP or HTTPS base URL without credentials, query or fragment.");
  if (!upstream && !draft.api_key.trim()) throw new Error("Enter the upstream API key.");
  return {
    name: draft.name.trim(), base_url: draft.base_url.trim().replace(/\/$/, ""), format: draft.format,
    ...(draft.api_key.trim() ? { api_key: draft.api_key.trim() } : {}),
    is_enabled: draft.is_enabled, supports_reasoning: draft.supports_reasoning,
    auth_style: draft.auth_style, use_socks5: draft.use_socks5, manual_models, quota,
  };
}

export function effectiveReset(reset: number, windowMinutes: number, now: number): number {
  const duration = windowMinutes * 60_000;
  return now < reset ? reset : reset + (Math.floor((now - reset) / duration) + 1) * duration;
}

import type { ProviderPublic, RoutingRule, RoutingRuleInput, RoutingTarget, UpstreamFormat } from "./routing-types";
import { toLocalWindows, toUtcWindows, type LocalWindow } from "./routing-schedule";

import { COPILOT_UPSTREAM_ID } from "../../../proxy/src/core/routing-types";
export { COPILOT_UPSTREAM_ID, COPILOT_RULE_ID } from "../../../proxy/src/core/routing-types";
export const FORMATS: { value: UpstreamFormat; label: string; short: string }[] = [
  { value: "anthropic_messages", label: "Anthropic Messages", short: "Messages" },
  { value: "chat_completions", label: "OpenAI Chat Completions", short: "Chat" },
  { value: "responses", label: "OpenAI Responses", short: "Responses" },
];
export interface RuleDraft extends Omit<RoutingRuleInput, "periods" | "allow_conversion"> {
  allow_conversion: boolean;
  windows: LocalWindow<RoutingTarget[]>[];
}

export function newRule(): RuleDraft {
  return { name: "", allow_conversion: false, mode: "all_day", default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }], windows: [] };
}

export function ruleDraft(rule: RoutingRule, offset: number): RuleDraft {
  return {
    name: rule.name, allow_conversion: rule.allow_conversion, mode: rule.mode,
    default_chain: structuredClone(rule.default_chain),
    windows: toLocalWindows(rule.periods.map(period => ({ ...period, value: structuredClone(period.targets) })), rule.mode, offset),
  };
}

export function validateChain(chain: RoutingTarget[], upstreams: ProviderPublic[]): void {
  if (!chain.length) throw new Error("Every chain needs a terminal fallback.");
  for (const target of chain) {
    if (!target.model.trim() || target.model.trim() === "auto") throw new Error('Choose an explicit model ID. "auto" is reserved for client requests.');
    if (!upstreams.some(upstream => upstream.id === target.upstream_id)) throw new Error("A target references a missing upstream. Choose another upstream.");
  }
}

export function rulePayload(draft: RuleDraft, upstreams: ProviderPublic[], offset: number): RoutingRuleInput {
  if (!draft.name.trim()) throw new Error("Give this rule a name.");
  validateChain(draft.default_chain, upstreams);
  const windows = toUtcWindows(draft.windows, draft.mode, offset);
  const clean = (targets: RoutingTarget[]) => targets.map(target => ({ upstream_id: target.upstream_id, model: target.model.trim() }));
  for (const window of windows) validateChain(window.value, upstreams);
  return {
    name: draft.name.trim(), mode: draft.mode, allow_conversion: draft.allow_conversion,
    default_chain: clean(draft.default_chain),
    periods: windows.map(window => ({ id: window.id, start_minute: window.start_minute, end_minute: window.end_minute, targets: clean(window.value) })),
  };
}

export function modelIds(upstream: ProviderPublic | undefined): string[] {
  return upstream ? [...new Set([...upstream.models.map(model => model.id), ...upstream.manual_models])].filter(id => id !== "auto") : [];
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (![from, to].every(index => Number.isInteger(index) && index >= 0 && index < items.length) || from === to) return items;
  const result = [...items];
  result.splice(to, 0, result.splice(from, 1)[0]!);
  return result;
}
export interface DragState { source: number | null; over: number | null }
export type DragAction = { type: "start" | "over"; index: number } | { type: "end" };
export const IDLE_DRAG: DragState = { source: null, over: null };
export function dragState(state: DragState, action: DragAction, length: number): DragState {
  if (action.type === "end") return IDLE_DRAG;
  if (!Number.isInteger(action.index) || action.index < 0 || action.index >= length) return state;
  if (action.type === "start") return { source: action.index, over: action.index };
  return state.source === null ? state : { ...state, over: action.index };
}

const ENDPOINT_FORMATS: Record<string, UpstreamFormat> = {
  "/v1/messages": "anthropic_messages",
  "/chat/completions": "chat_completions",
  "/v1/chat/completions": "chat_completions",
  "/responses": "responses",
  "/v1/responses": "responses",
};
export type Compatibility = "Native" | "Convert" | "Blocked" | "Unavailable";
export function compatibility(upstream: ProviderPublic | undefined, model: string, incoming: UpstreamFormat, conversion: boolean, automatic = true): Compatibility {
  if (!upstream) return "Unavailable";
  if (upstream.kind === "custom") return upstream.format === incoming ? "Native" : conversion ? "Convert" : "Blocked";
  const endpoints = upstream.models.find(entry => entry.id === model)?.supported_endpoints;
  const formats = Array.isArray(endpoints) ? endpoints.map(endpoint => typeof endpoint === "string" ? ENDPOINT_FORMATS[endpoint] : undefined).filter(Boolean) : [];
  if (!formats.length) {
    if (automatic) return "Unavailable";
    return conversion && incoming === "anthropic_messages" ? "Convert" : "Native";
  }
  if (formats.includes(incoming)) return "Native";
  return conversion ? "Convert" : "Blocked";
}

export interface ChainPreview { selected: number | null; labels: string[]; warnings: string[] }
export function previewChain(chain: RoutingTarget[], upstreams: ProviderPublic[]): ChainPreview {
  const labels: string[] = [];
  const warnings: string[] = [];
  let selected: number | null = null;
  let stopped = false;
  for (const [index, target] of chain.entries()) {
    const upstream = upstreams.find(item => item.id === target.upstream_id);
    if (stopped) { labels.push("Later target"); continue; }
    if (!upstream) { labels.push("Missing upstream"); stopped = true; continue; }
    if (upstream.quota && !upstream.quota_status.healthy) {
      labels.push("Accounting blocked"); stopped = true; continue;
    }
    if (upstream.quota && upstream.quota_status.remaining_tokens === null) {
      labels.push("Quota state unavailable"); stopped = true; continue;
    }
    if (upstream.quota && upstream.quota_status.remaining_tokens! <= 0) {
      labels.push("Exhausted · skip"); continue;
    }
    if (!upstream.is_enabled) { labels.push("Disabled · request stops"); stopped = true; continue; }
    selected = index;
    labels.push("Selected now");
    stopped = true;
  }
  for (const [index, target] of chain.entries()) {
    const upstream = upstreams.find(item => item.id === target.upstream_id);
    if (upstream && !upstream.quota && index < chain.length - 1) {
      warnings.push(`${upstream.name} has no quota: targets after position ${index + 1} are unreachable.`);
    }
  }
  if (chain.length > 0 && !stopped) warnings.push("All targets are exhausted. This chain returns quota_exhausted (429).");
  return { selected, labels, warnings };
}

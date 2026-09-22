import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID } from "../../src/lib/routing-model";
import type { MigrationSummary, ProviderPublic, QuotaPolicy, RoutingRule } from "../../src/lib/routing-types";
import type { RequestRouting } from "../../src/lib/types";

export const FIXTURE_NOW = Date.UTC(2026, 8, 22, 8);
export const fixtureQuota: QuotaPolicy = { limit_tokens: 100_000, window_minutes: 300, next_reset_at: FIXTURE_NOW + 3_600_000, mode: "all_day", multipliers: [] };

export function makeUpstream(overrides: Partial<ProviderPublic> = {}): ProviderPublic {
  return {
    id: "custom:research", name: "Research gateway", kind: "custom", format: "chat_completions",
    base_url: "https://fixture.invalid/v1", api_key_preview: "fixture…key", is_enabled: true,
    supports_reasoning: true, auth_style: "bearer", use_socks5: null,
    manual_models: ["research-manual"], models: [{ id: "research-large", supported_endpoints: ["/chat/completions"] }],
    last_refreshed_at: FIXTURE_NOW, last_refresh_error: null, quota: fixtureQuota,
    quota_status: { window_id: "fixture-window", starts_at: FIXTURE_NOW - 3_600_000, ends_at: FIXTURE_NOW + 3_600_000, used_tokens: 18_420.5, limit_tokens: 100_000, remaining_tokens: 81_579.5, multiplier: 1, healthy: true, usage_complete: true },
    created_at: FIXTURE_NOW, updated_at: FIXTURE_NOW, ...overrides,
  };
}

export function makeCopilot(overrides: Partial<ProviderPublic> = {}): ProviderPublic {
  return makeUpstream({ id: COPILOT_UPSTREAM_ID, name: "GitHub Copilot", kind: "copilot", format: null, base_url: "", api_key_preview: "", auth_style: null,
    manual_models: [], models: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }, { id: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages"] }], quota: null,
    quota_status: { window_id: null, starts_at: null, ends_at: null, used_tokens: 0, limit_tokens: null, remaining_tokens: null, multiplier: 1, healthy: true, usage_complete: true }, ...overrides });
}

export function makeRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return { id: COPILOT_RULE_ID, name: "GitHub Copilot", is_builtin: true, allow_conversion: true, mode: "all_day", default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }], periods: [], created_at: FIXTURE_NOW, updated_at: FIXTURE_NOW, ...overrides };
}

export const fixtureUpstreams = [makeCopilot(), makeUpstream()];
export const fixtureRules = [makeRule(), makeRule({ id: "rule:working-hours", name: "Working hours", is_builtin: false, mode: "weekly", allow_conversion: false,
  default_chain: [{ upstream_id: "custom:research", model: "research-large" }, { upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }],
  periods: [
    { id: "monday-focus", start_minute: 540, end_minute: 1020, targets: [{ upstream_id: "custom:research", model: "research-manual" }, { upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }] },
    { id: "friday-night", start_minute: 4 * 1440 + 1320, end_minute: 5 * 1440, targets: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }] },
    { id: "friday-night", start_minute: 5 * 1440, end_minute: 5 * 1440 + 120, targets: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }] },
  ] })];
export const fixtureMigration: MigrationSummary = {
  migrated_at: FIXTURE_NOW,
  upstreams: [{ id: "custom:research", name: "Research gateway", retained_models: ["research-manual"], discarded_patterns: ["research-*"] }],
  keys: [{ id: "key:fixture", name: "Work laptop", rule_id: COPILOT_RULE_ID }],
};

export const fixtureRequestRouting: RequestRouting = {
  requested_model: "auto", resolved_model: "gpt-5.6-sol", rule_id: "rule:working-hours", period_id: "monday-focus",
  upstream_id: COPILOT_UPSTREAM_ID, upstream_name: "GitHub Copilot", quota_window_id: "fixture-window",
  multiplier: 0.5, weighted_tokens: 321.5, usage_complete: true, accounting_healthy: true,
  admitted_at: FIXTURE_NOW, skipped: [{ upstream_id: "custom:research", reason: "quota_exhausted" }], diagnostic: false,
};

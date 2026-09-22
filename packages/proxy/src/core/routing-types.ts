export const COPILOT_UPSTREAM_ID = "builtin:copilot"
export const COPILOT_RULE_ID = "builtin:copilot"

export type UpstreamFormat = "anthropic_messages" | "chat_completions" | "responses"
export type UpstreamKind = "copilot" | "custom"
export type ProviderAuthStyle = "x-api-key" | "bearer"
export type ScheduleMode = "all_day" | "daily" | "weekly"

export interface RoutingTarget {
  upstream_id: string
  model: string
}

export interface ScheduleInterval {
  id: string
  start_minute: number
  end_minute: number
}

export interface RoutingPeriod extends ScheduleInterval {
  targets: RoutingTarget[]
}

export interface RoutingRule {
  id: string
  name: string
  allow_conversion: boolean
  mode: ScheduleMode
  default_chain: RoutingTarget[]
  periods: RoutingPeriod[]
  is_builtin: boolean
  created_at: number
  updated_at: number
}

export interface RoutingRuleInput {
  name: string
  allow_conversion?: boolean
  mode: ScheduleMode
  default_chain: RoutingTarget[]
  periods: RoutingPeriod[]
}

export interface QuotaMultiplier extends ScheduleInterval {
  multiplier: number
}

export interface QuotaPolicy {
  limit_tokens: number
  window_minutes: number
  next_reset_at: number
  mode: ScheduleMode
  multipliers: QuotaMultiplier[]
}

export interface CatalogModel {
  id: string
  supported_endpoints?: string[]
  [key: string]: unknown
}

export interface UpstreamRecord {
  id: string
  name: string
  kind: UpstreamKind
  format: UpstreamFormat | null
  base_url: string
  api_key: string
  is_enabled: boolean
  supports_reasoning: boolean
  auth_style: ProviderAuthStyle | null
  use_socks5: boolean | null
  manual_models: string[]
  models: CatalogModel[]
  last_refreshed_at: number | null
  last_refresh_error: string | null
  quota: QuotaPolicy | null
  created_at: number
  updated_at: number
}

export interface QuotaStatus {
  window_id: string | null
  starts_at: number | null
  ends_at: number | null
  used_tokens: number
  limit_tokens: number | null
  remaining_tokens: number | null
  multiplier: number
  healthy: boolean
  usage_complete: boolean
}

export interface ProviderPublic extends Omit<UpstreamRecord, "api_key"> {
  api_key_preview: string
  quota_status: QuotaStatus
}

export interface UpstreamOperationDetails {
  operation: "model_discovery" | "generation_test"
  method?: string
  url?: string
  upstream_status?: number
  content_type?: string
  request_id?: string
  response_body?: string
  response_body_truncated?: boolean
  finish_reason?: string
  response_status?: string
}

export interface UpstreamDiagnostic {
  success: true
  latency_ms: number
  model: string
  protocol: string
  answer: string
  expected_pong: boolean
  answer_truncated: boolean
  details: UpstreamOperationDetails
}

export interface CreateProviderInput {
  name: string
  base_url: string
  format: UpstreamFormat
  api_key: string
  is_enabled?: boolean
  supports_reasoning?: boolean
  auth_style?: ProviderAuthStyle | null
  use_socks5?: boolean | null
  manual_models?: string[]
  quota?: QuotaPolicy | null
}

export type UpdateProviderInput = Partial<CreateProviderInput>

export interface QuotaCapture {
  upstream_id: string
  window_id: string | null
  multiplier: number
  captured_at: number
}

export interface NormalizedQuotaUsage {
  input_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  output_tokens: number | null
  complete: boolean
  usage_present?: boolean
}

export interface QuotaSettlementInput {
  request_id: string
  attempt_ordinal: number
  capture: QuotaCapture
  usage: NormalizedQuotaUsage
}

export interface QuotaSettlementResult {
  committed: boolean
  duplicate: boolean
  weighted_debit: number
  error: string | null
}

export interface RoutingSelection {
  rule_id: string
  period_id: string | null
  allow_conversion: boolean
  requested_model: string
  resolved_model: string
  upstream: UpstreamRecord
  quota: QuotaCapture
  skipped: { upstream_id: string; reason: "quota_exhausted" }[]
}

export interface RoutingSelectionInput {
  rule: RoutingRule | null
  requested_model: string
  now: number
  upstreams: readonly UpstreamRecord[]
  quota_status: ReadonlyMap<string, QuotaStatus>
}

export interface RoutingReference {
  kind: "key" | "rule" | "builtin"
  id: string
  name: string
}

export interface RoutingMigrationSummary {
  migrated_at: number
  upstreams: {
    id: string
    name: string
    retained_models: string[]
    discarded_patterns: string[]
  }[]
  keys: { id: string; name: string; rule_id: string }[]
}

export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly type: string = "validation_error",
    public readonly status: 400 | 404 | 409 | 429 | 503 = 400,
    public readonly references: RoutingReference[] = [],
    public readonly details?: UpstreamOperationDetails,
  ) {
    super(message)
    this.name = "RoutingError"
  }
}

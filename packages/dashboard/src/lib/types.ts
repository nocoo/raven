/**
 * TypeScript interfaces for proxy API responses.
 * These mirror the types in packages/proxy/src/db/requests.ts
 */

export interface OverviewStats {
  total_requests: number;
  total_tokens: number;
  error_count: number;
  avg_latency_ms: number;
}

export interface TimeseriesBucket {
  bucket: number; // unix ms start of bucket
  count: number;
  total_tokens: number;
  avg_latency_ms: number;
}

export interface ModelStats {
  model: string;
  count: number;
  total_tokens: number;
  avg_latency_ms: number;
}

export interface RequestRecord {
  id: string;
  timestamp: number;
  path: string;
  client_format: string;
  model: string;
  resolved_model: string | null;
  stream: number;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  ttft_ms: number | null;
  status: string;
  status_code: number;
  upstream_status: number | null;
  error_message: string | null;
  account_name: string;
  session_id: string;
  client_name: string;
  client_version: string | null;
}

export interface PaginatedRequests {
  data: RequestRecord[];
  next_cursor?: string;
  has_more: boolean;
  total?: number;
}

// ---------------------------------------------------------------------------
// Enhanced analytics types (matching proxy /stats/* endpoints)
// ---------------------------------------------------------------------------

export interface SummaryStats {
  total_requests: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  error_count: number;
  error_rate: number;
  avg_latency_ms: number;
  avg_ttft_ms: number | null;
  avg_processing_ms: number | null;
  stream_count: number;
  sync_count: number;
}

export interface ExtendedTimeseriesBucket {
  bucket: number;
  count: number;
  success_count: number;
  error_count: number;
  stream_count: number;
  sync_count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  avg_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  avg_processing_ms: number | null;
  status_codes: Record<string, number>;
}

export interface BreakdownEntry {
  key: string;
  count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  avg_ttft_ms: number | null;
  error_count: number;
  error_rate: number;
  first_seen: number;
  last_seen: number;
  // Session breakdown extras
  client_name?: string;
  account_name?: string;
  client_version?: string | null;
}

export interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Extended RequestRecord (with new fields from analytics enhancement)
// ---------------------------------------------------------------------------

export interface ExtendedRequestRecord extends RequestRecord {
  processing_ms: number | null;
  strategy: string;
  upstream: string;
  upstream_format: string;
  translated_model: string;
  copilot_model: string;
  routing_path: string;
  stop_reason: string;
  tool_call_count: number;
}

// ---------------------------------------------------------------------------
// Copilot API types (from api.githubcopilot.com/models)
// ---------------------------------------------------------------------------

export interface CopilotModelCapabilities {
  family: string;
  type: string;
  tokenizer: string;
  limits?: {
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
    max_output_tokens?: number;
  };
}

export interface CopilotModelPolicy {
  type: string;
  terms?: string;
}

export interface CopilotModel {
  id: string;
  name: string;
  version: string;
  is_custom_model?: boolean;
  model_picker_enabled: boolean;
  preview_state?: string;
  capabilities: CopilotModelCapabilities;
  policy?: CopilotModelPolicy;
  vendor?: string;
}

export interface CopilotModelList {
  object: string;
  data: CopilotModel[];
}

// ---------------------------------------------------------------------------
// Copilot user/subscription info (from api.github.com/copilot_internal/user)
// ---------------------------------------------------------------------------

export interface CopilotQuotaSnapshot {
  quota_id: string;
  entitlement: number;
  remaining: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_remaining: number;
  unlimited: boolean;
  timestamp_utc?: string;
}

export interface CopilotEndpoints {
  api?: string;
  proxy?: string;
  telemetry?: string;
  "origin-tracker"?: string;
  [key: string]: string | undefined;
}

export interface CopilotOrganization {
  login: string;
  name?: string;
}

export interface CopilotUser {
  login?: string;
  copilot_plan?: string;
  access_type_sku?: string;
  chat_enabled?: boolean;
  copilotignore_enabled?: boolean;
  is_mcp_enabled?: boolean;
  restricted_telemetry?: boolean;
  can_signup_for_limited?: boolean;
  assigned_date?: string;
  organization_login_list?: string[];
  organization_list?: CopilotOrganization[];
  endpoints?: CopilotEndpoints;
  quota_snapshots?: Record<string, CopilotQuotaSnapshot>;
  quota_reset_date?: string;
  quota_reset_date_utc?: string;
  analytics_tracking_id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// API Key types
// ---------------------------------------------------------------------------

export interface ApiKeyPublic {
  id: string;
  name: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ApiKeyCreated extends ApiKeyPublic {
  key: string;
}

// ---------------------------------------------------------------------------
// Connection info types
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  owned_by: string;
}

export interface ConnectionInfo {
  base_url: string;
  endpoints: {
    chat_completions: string;
    messages: string;
    models: string;
    embeddings: string;
  };
  models: string[];
  model_list?: ModelInfo[]; // new: with owned_by for grouping
}

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export interface SettingInfo {
  effective: string;
  source: string;
  override: string | null;
}

export interface OptimizationInfo {
  enabled: boolean;
  key: string;
}

export interface ServerToolInfo {
  enabled: boolean;
  has_api_key: boolean;
}

export interface SoundInfo {
  available: boolean;
  enabled: boolean;
  sound_name: string;
  available_sounds: string[];
}

export interface IPWhitelistInfo {
  enabled: boolean;
  trust_proxy: boolean;
  ranges: string[];
}

export interface SettingsData {
  vscode_version: SettingInfo;
  copilot_chat_version: SettingInfo;
  optimizations: Record<string, OptimizationInfo>;
  debug: Record<string, OptimizationInfo>;
  server_tools: Record<string, ServerToolInfo>;
  sound: SoundInfo;
  ip_whitelist: IPWhitelistInfo;
}

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export type ProviderFormat = "openai" | "anthropic";

export interface ProviderPublic {
  id: string;
  name: string;
  base_url: string;
  format: ProviderFormat;
  api_key_preview: string;
  model_patterns: string[];
  is_enabled: boolean;
  supports_reasoning: boolean;
  supports_models_endpoint: boolean | null;
  created_at: number;
  updated_at: number;
}

export interface CreateProviderInput {
  name: string;
  base_url: string;
  format: ProviderFormat;
  api_key: string;
  model_patterns: string[];
  is_enabled?: boolean;
  supports_reasoning?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  base_url?: string;
  format?: ProviderFormat;
  api_key?: string;
  model_patterns?: string[];
  is_enabled?: boolean;
  supports_reasoning?: boolean;
}

// ---------------------------------------------------------------------------
// Upstream health check / models
// ---------------------------------------------------------------------------

export interface UpstreamModelsResponse {
  healthy: boolean;
  total?: number;
  models?: Record<string, string[]>;
  supports_models_endpoint?: boolean;
  error?: {
    message: string;
    type: string;
  };
}



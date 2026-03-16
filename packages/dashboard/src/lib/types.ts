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
}

export interface PaginatedRequests {
  data: RequestRecord[];
  next_cursor?: string;
  has_more: boolean;
  total?: number;
}

// ---------------------------------------------------------------------------
// Copilot API types (from api.githubcopilot.com/models)
// ---------------------------------------------------------------------------

export interface CopilotModelCapabilities {
  family: string;
  type: string;
  tokenizer: string;
  limits?: {
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

export interface ConnectionInfo {
  base_url: string;
  endpoints: {
    chat_completions: string;
    messages: string;
    models: string;
    embeddings: string;
  };
  models: string[];
}

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export interface SettingInfo {
  effective: string;
  source: string;
  override: string | null;
}

export type SettingsData = Record<string, SettingInfo>;


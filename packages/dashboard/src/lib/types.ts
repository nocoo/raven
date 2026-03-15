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

// ---------------------------------------------------------------------------
// Copilot user/subscription info (from api.github.com/copilot_internal/user)
// ---------------------------------------------------------------------------

export interface CopilotUser {
  /** GitHub login */
  login?: string;
  /** Subscription tier (e.g. "copilot_for_business") */
  copilot_plan?: string;
  /** Whether the user has access to Copilot Chat */
  chat_enabled?: boolean;
  /** Whether the user has access to Copilot in the IDE */
  copilot_ide_agent_chat_enabled?: boolean;
  /** Whether the user has access to xcode */
  xcode?: boolean;
  /** Whether the user has access to CLI */
  copilot_ide_chat_enabled?: boolean;
  /** Organization managing the subscription */
  organization_name?: string;
  /** Seat management pending cancellation date */
  pending_cancellation_date?: string | null;
  /** Raw fields from the API we haven't typed explicitly */
  [key: string]: unknown;
}

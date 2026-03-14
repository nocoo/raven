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

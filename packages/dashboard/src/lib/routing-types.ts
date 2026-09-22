export type {
  CatalogModel, CreateProviderInput, ProviderPublic, QuotaMultiplier, QuotaPolicy,
  QuotaStatus, RoutingPeriod, RoutingRule, RoutingRuleInput, RoutingTarget,
  ScheduleMode, UpdateProviderInput, UpstreamFormat,
  RoutingMigrationSummary as MigrationSummary,
} from "../../../proxy/src/core/routing-types";

export interface UpstreamDiagnostic {
  success: true;
  latency_ms: number;
  model: string;
  protocol: string;
  answer: string;
  expected_pong: boolean;
}

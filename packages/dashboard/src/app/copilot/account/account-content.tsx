"use client";



import type { CopilotUser, CopilotQuotaSnapshot } from "@/lib/types";
import { LocalTime } from "@/components/local-time";
import { SectionIcon, type SectionIconTone } from "@/components/section-icon";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw, User, Building2, CreditCard, Calendar, CheckCircle2, XCircle, Infinity as InfinityIcon, Sparkles, Braces, type LucideIcon, } from "lucide-react";
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, LayerCard } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";

interface AccountContentProps {
  data: CopilotUser;
}

// All fields we render explicitly — everything else is truly unknown
const KNOWN_KEYS = new Set([
  "login",
  "copilot_plan",
  "access_type_sku",
  "chat_enabled",
  "copilotignore_enabled",
  "is_mcp_enabled",
  "restricted_telemetry",
  "can_signup_for_limited",
  "assigned_date",
  "organization_login_list",
  "organization_list",
  "endpoints",
  "quota_snapshots",
  "quota_reset_date",
  "quota_reset_date_utc",
  "analytics_tracking_id",
]);

// ── Small reusable pieces ──

function BoolBadge({ value }: { value: boolean }) {
  return value ? (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" />
      Enabled
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1">
      <XCircle className="h-3 w-3" />
      Disabled
    </Badge>
  );
}

function InfoRow({
  icon,
  tone,
  label,
  children,
}: {
  icon: LucideIcon;
  tone: SectionIconTone;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <LayerCard padding="sm" className="flex items-center gap-3">
      <SectionIcon icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-basalt-muted-foreground">{label}</p>
        <div className="mt-0.5">{children}</div>
      </div>
    </LayerCard>
  );
}

function ToggleRow({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-sm">{label}</span>
      <BoolBadge value={value} />
    </div>
  );
}

const RING_SIZE = 80;
const RING_STROKE = 6;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function QuotaRing({ percent, unlimited }: { percent: number; unlimited: boolean }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const offset = unlimited ? 0 : RING_CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <div className="relative flex items-center justify-center" style={{ width: RING_SIZE, height: RING_SIZE }}>
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        className="-rotate-90"
        role="img"
        aria-label={unlimited ? "Unlimited quota" : `Quota usage ${clamped.toFixed(0)}%`}
      >
        <title>{unlimited ? "Unlimited quota" : `Quota usage ${clamped.toFixed(0)}%`}</title>
        {/* Background track */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          className="text-basalt-muted/40"
        />
        {/* Foreground arc */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={unlimited ? "text-basalt-primary" : clamped > 20 ? "text-basalt-primary" : "text-basalt-destructive"}
          style={{ transition: "stroke-dashoffset 0.3s ease" }}
        />
      </svg>
      {/* Center label */}
      <span className="absolute inset-0 flex items-center justify-center">
        {unlimited ? (
          <InfinityIcon className="h-5 w-5 text-basalt-primary" strokeWidth={2} />
        ) : (
          <span className="text-sm font-semibold tabular-nums">{Math.round(clamped)}%</span>
        )}
      </span>
    </div>
  );
}

function QuotaCard({ id, snapshot }: { id: string; snapshot: CopilotQuotaSnapshot }) {
  const label = id
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <LayerCard className="flex items-center gap-4">
      <QuotaRing percent={snapshot.percent_remaining} unlimited={snapshot.unlimited} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {snapshot.unlimited ? (
          <p className="text-xs text-basalt-muted-foreground">Unlimited usage</p>
        ) : (
          <p className="text-xs text-basalt-muted-foreground">
            {snapshot.remaining.toLocaleString()} / {snapshot.entitlement.toLocaleString()} remaining
          </p>
        )}
        {snapshot.overage_count > 0 && (
          <p className="text-xs text-basalt-destructive">
            {snapshot.overage_count} overage{snapshot.overage_count !== 1 ? "s" : ""}
          </p>
        )}
      </div>
    </LayerCard>
  );
}

// ── Render helpers for unknown extra fields ──

function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-basalt-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return <BoolBadge value={value} />;
  }
  if (typeof value === "string" || typeof value === "number") {
    return <span className="font-mono text-xs break-all">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-basalt-muted-foreground">[]</span>;
    // Array of primitives → comma-separated
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return <span className="font-mono text-xs break-all">{value.join(", ")}</span>;
    }
  }
  // Fallback: pretty-print JSON
  return (
    <pre className="font-mono text-xs whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ── Main component ──

export function AccountContent({ data }: AccountContentProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const loading = isPending || isRefreshing;

  async function handleRefresh() {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      await fetch("/api/copilot/user?refresh=true");
      startTransition(() => router.refresh());
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }

  const extraEntries = Object.entries(data).filter(
    ([key]) => !KNOWN_KEYS.has(key),
  );

  const orgs = data.organization_list ?? [];
  const quotas = data.quota_snapshots
    ? Object.entries(data.quota_snapshots)
    : [];

  return (
    <>
      <PageHeader title="Account" description="GitHub Copilot subscription and quota." actions={
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      } />

      {refreshError && (
        <p className="text-xs text-basalt-destructive">{refreshError}</p>
      )}

      {/* Subscription overview */}
      <div className="grid grid-cols-1 @min-[32rem]/page:grid-cols-2 @min-[48rem]/page:grid-cols-3 gap-3">
        {data.login != null && (
          <InfoRow icon={User} tone="purple" label="GitHub Login">
            <p className="text-sm font-medium">{data.login}</p>
          </InfoRow>
        )}

        {data.copilot_plan != null && (
          <InfoRow icon={CreditCard} tone="blue" label="Plan">
            <Badge variant="info">{data.copilot_plan}</Badge>
            {data.access_type_sku && (
              <p className="text-xs text-basalt-muted-foreground mt-0.5 font-mono">
                {data.access_type_sku}
              </p>
            )}
          </InfoRow>
        )}

        {orgs.length > 0 && (
          <InfoRow icon={Building2} tone="teal" label="Organization">
            {orgs.map((org) => (
              <p key={org.login} className="text-sm font-medium">
                {org.name ?? org.login}
                {org.name && (
                  <span className="text-xs text-basalt-muted-foreground ml-1">
                    ({org.login})
                  </span>
                )}
              </p>
            ))}
          </InfoRow>
        )}

        {data.assigned_date != null && (
          <InfoRow icon={Calendar} tone="orange" label="Assigned Date">
            <p className="text-sm font-medium">
              <LocalTime timestamp={new Date(data.assigned_date).getTime()} precision="day" />
            </p>
          </InfoRow>
        )}

      </div>

      {/* Quota snapshots */}
      {quotas.length > 0 && (
        <SectionRule
          title="Quota"
          hint={data.quota_reset_date ? `Resets ${data.quota_reset_date}` : undefined}
        >
          <div className="grid grid-cols-1 @min-[32rem]/page:grid-cols-2 @min-[48rem]/page:grid-cols-3 gap-3">
            {quotas.map(([id, snapshot]) => (
              <QuotaCard key={id} id={id} snapshot={snapshot} />
            ))}
          </div>
        </SectionRule>
      )}

      <div className="settings-grid">
      {[data.chat_enabled, data.copilotignore_enabled, data.is_mcp_enabled, data.restricted_telemetry, data.can_signup_for_limited].some(value => value != null) &&
        <LayerCard padding="none" className="overflow-hidden">
          <LayerCard.Header><h2 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Sparkles} tone="teal" />Capabilities</h2></LayerCard.Header>
          <div className="max-w-3xl divide-y divide-basalt-border/50">
          {data.chat_enabled != null && (
            <ToggleRow label="Chat" value={data.chat_enabled} />
          )}
          {data.copilotignore_enabled != null && (
            <ToggleRow label="Copilot Ignore" value={data.copilotignore_enabled} />
          )}
          {data.is_mcp_enabled != null && (
            <ToggleRow label="MCP" value={data.is_mcp_enabled} />
          )}
          {data.restricted_telemetry != null && (
            <ToggleRow label="Restricted Telemetry" value={data.restricted_telemetry} />
          )}
          {data.can_signup_for_limited != null && (
            <ToggleRow label="Can Signup for Limited" value={data.can_signup_for_limited} />
          )}
          </div>
        </LayerCard>}

      {(data.analytics_tracking_id != null || (data.endpoints && Object.keys(data.endpoints).length > 0) || extraEntries.length > 0) &&
          <Collapsible asChild><LayerCard>
            <LayerCard.Header><h2 className="w-full"><CollapsibleTrigger className="w-full justify-between text-sm font-semibold text-basalt-foreground"><span className="flex items-center gap-2.5"><SectionIcon icon={Braces} tone="blue" />Endpoints and properties</span></CollapsibleTrigger></h2></LayerCard.Header>
            <CollapsibleContent unstyled><LayerCard.Body className="space-y-4">
              {data.analytics_tracking_id != null && <div className="space-y-1"><p className="text-xs text-basalt-muted-foreground">Tracking ID</p><p className="break-all font-mono text-xs">{data.analytics_tracking_id}</p></div>}
      {data.endpoints && Object.keys(data.endpoints).length > 0 && (
        <section aria-label="Endpoints" className="divide-y divide-basalt-border/50">
            {Object.entries(data.endpoints).map(([name, url]) => (
              <div
                key={name}
                className="space-y-1 py-2 text-sm"
              >
                <span className="block font-mono text-xs text-basalt-muted-foreground">
                  {name}
                </span>
                <span className="block break-all font-mono text-xs">
                  {url}
                </span>
              </div>
            ))}
        </section>
      )}

      {extraEntries.length > 0 && (
        <section aria-label="Other properties" className="divide-y divide-basalt-border/50">
            {extraEntries.map(([key, value]) => (
              <div
                key={key}
                className="space-y-1 py-2 text-sm"
              >
                <span className="block break-all font-mono text-xs text-basalt-muted-foreground">
                  {key}
                </span>
                <div>{renderValue(value)}</div>
              </div>
            ))}
        </section>
      )}
            </LayerCard.Body></CollapsibleContent>
          </LayerCard></Collapsible>}
      </div>
    </>
  );
}

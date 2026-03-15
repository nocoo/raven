"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  User,
  Building2,
  CreditCard,
  MessageSquare,
  Globe,
  Calendar,
  Gauge,
  CheckCircle2,
  XCircle,
  Infinity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CopilotUser, CopilotQuotaSnapshot } from "@/lib/types";

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
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-secondary p-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-widget bg-primary/10">
        <Icon className="h-4 w-4 text-primary" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5">{children}</div>
      </div>
    </div>
  );
}

function ToggleRow({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
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
      <svg width={RING_SIZE} height={RING_SIZE} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          className="text-muted/40"
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
          className={unlimited ? "text-primary" : clamped > 20 ? "text-primary" : "text-destructive"}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      {/* Center label */}
      <span className="absolute inset-0 flex items-center justify-center">
        {unlimited ? (
          <Infinity className="h-5 w-5 text-primary" strokeWidth={2} />
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
    <div className="flex items-center gap-4 rounded-lg bg-secondary p-4">
      <QuotaRing percent={snapshot.percent_remaining} unlimited={snapshot.unlimited} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {snapshot.unlimited ? (
          <p className="text-xs text-muted-foreground">Unlimited usage</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {snapshot.remaining.toLocaleString()} / {snapshot.entitlement.toLocaleString()} remaining
          </p>
        )}
        {snapshot.overage_count > 0 && (
          <p className="text-xs text-destructive">
            {snapshot.overage_count} overage{snapshot.overage_count !== 1 ? "s" : ""}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Render helpers for unknown extra fields ──

function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return <BoolBadge value={value} />;
  }
  if (typeof value === "string" || typeof value === "number") {
    return <span className="font-mono text-xs break-all">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">[]</span>;
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

  const loading = isPending || isRefreshing;

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await fetch("/api/copilot/user?refresh=true");
      startTransition(() => router.refresh());
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
      {/* Refresh */}
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Subscription overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {data.login != null && (
          <InfoRow icon={User} label="GitHub Login">
            <p className="text-sm font-medium">{data.login}</p>
          </InfoRow>
        )}

        {data.copilot_plan != null && (
          <InfoRow icon={CreditCard} label="Plan">
            <Badge variant="info">{data.copilot_plan}</Badge>
            {data.access_type_sku && (
              <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                {data.access_type_sku}
              </p>
            )}
          </InfoRow>
        )}

        {orgs.length > 0 && (
          <InfoRow icon={Building2} label="Organization">
            {orgs.map((org) => (
              <p key={org.login} className="text-sm font-medium">
                {org.name ?? org.login}
                {org.name && (
                  <span className="text-xs text-muted-foreground ml-1">
                    ({org.login})
                  </span>
                )}
              </p>
            ))}
          </InfoRow>
        )}

        {data.assigned_date != null && (
          <InfoRow icon={Calendar} label="Assigned Date">
            <p className="text-sm font-medium">
              {new Date(data.assigned_date).toLocaleDateString()}
            </p>
          </InfoRow>
        )}

        {data.chat_enabled != null && (
          <InfoRow icon={MessageSquare} label="Chat">
            <BoolBadge value={data.chat_enabled} />
          </InfoRow>
        )}

        {data.analytics_tracking_id != null && (
          <InfoRow icon={Globe} label="Tracking ID">
            <p className="text-xs font-mono text-muted-foreground break-all">
              {data.analytics_tracking_id}
            </p>
          </InfoRow>
        )}
      </div>

      {/* Quota snapshots */}
      {quotas.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            <h2 className="text-sm font-medium text-muted-foreground">Quota</h2>
            {data.quota_reset_date && (
              <span className="text-xs text-muted-foreground ml-auto">
                Resets {data.quota_reset_date}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {quotas.map(([id, snapshot]) => (
              <QuotaCard key={id} id={id} snapshot={snapshot} />
            ))}
          </div>
        </div>
      )}

      {/* Feature toggles */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Feature Toggles</h2>
        <div className="rounded-lg border overflow-hidden divide-y">
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
      </div>

      {/* Endpoints */}
      {data.endpoints && Object.keys(data.endpoints).length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            <h2 className="text-sm font-medium text-muted-foreground">Endpoints</h2>
          </div>
          <div className="rounded-lg border overflow-hidden divide-y">
            {Object.entries(data.endpoints).map(([name, url]) => (
              <div
                key={name}
                className="flex items-center justify-between px-4 py-2.5 text-sm gap-4"
              >
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {name}
                </span>
                <span className="font-mono text-xs truncate text-right">
                  {url}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unknown extra fields */}
      {extraEntries.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Other Properties
          </h2>
          <div className="rounded-lg border overflow-hidden divide-y">
            {extraEntries.map(([key, value]) => (
              <div
                key={key}
                className="flex items-start justify-between px-4 py-2.5 text-sm gap-4"
              >
                <span className="font-mono text-xs text-muted-foreground shrink-0 pt-0.5">
                  {key}
                </span>
                <div className="text-right">{renderValue(value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

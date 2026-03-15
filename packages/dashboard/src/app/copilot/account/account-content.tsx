"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  User,
  Building2,
  CreditCard,
  MessageSquare,
  Code2,
  Terminal,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CopilotUser } from "@/lib/types";

interface AccountContentProps {
  data: CopilotUser;
}

/** Known fields we render explicitly — everything else goes into "Other" */
const KNOWN_KEYS = new Set([
  "login",
  "copilot_plan",
  "chat_enabled",
  "copilot_ide_agent_chat_enabled",
  "xcode",
  "copilot_ide_chat_enabled",
  "organization_name",
  "pending_cancellation_date",
]);

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

  // Collect extra fields not in KNOWN_KEYS
  const extraEntries = Object.entries(data).filter(
    ([key]) => !KNOWN_KEYS.has(key),
  );

  return (
    <>
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {data.login !== undefined && (
          <InfoRow icon={User} label="GitHub Login">
            <p className="text-sm font-medium">{String(data.login)}</p>
          </InfoRow>
        )}

        {data.organization_name !== undefined && (
          <InfoRow icon={Building2} label="Organization">
            <p className="text-sm font-medium">
              {String(data.organization_name)}
            </p>
          </InfoRow>
        )}

        {data.copilot_plan !== undefined && (
          <InfoRow icon={CreditCard} label="Plan">
            <Badge variant="info">{String(data.copilot_plan)}</Badge>
          </InfoRow>
        )}

        {data.chat_enabled !== undefined && (
          <InfoRow icon={MessageSquare} label="Chat">
            <BoolBadge value={Boolean(data.chat_enabled)} />
          </InfoRow>
        )}

        {data.copilot_ide_agent_chat_enabled !== undefined && (
          <InfoRow icon={Code2} label="IDE Agent Chat">
            <BoolBadge
              value={Boolean(data.copilot_ide_agent_chat_enabled)}
            />
          </InfoRow>
        )}

        {data.copilot_ide_chat_enabled !== undefined && (
          <InfoRow icon={Terminal} label="IDE Chat">
            <BoolBadge value={Boolean(data.copilot_ide_chat_enabled)} />
          </InfoRow>
        )}

        {data.pending_cancellation_date !== undefined &&
          data.pending_cancellation_date !== null && (
            <InfoRow icon={CreditCard} label="Pending Cancellation">
              <p className="text-sm font-medium text-destructive">
                {String(data.pending_cancellation_date)}
              </p>
            </InfoRow>
          )}
      </div>

      {extraEntries.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Other Properties
          </h2>
          <div className="rounded-lg border bg-secondary/50 overflow-hidden">
            <div className="divide-y">
              {extraEntries.map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {key}
                  </span>
                  <span className="font-mono text-xs">
                    {typeof value === "boolean" ? (
                      <BoolBadge value={value} />
                    ) : (
                      String(value ?? "null")
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

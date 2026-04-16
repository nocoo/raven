"use client";

import { useState, useTransition, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import type { CopilotModel } from "@/lib/types";

interface CopilotModelsContentProps {
  data: CopilotModel[];
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 800);
    } catch {
      // Clipboard API may fail (e.g., no permission) — fail silently
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      aria-label={`Copy ${text}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-success" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

interface VendorGroup {
  vendor: string;
  models: CopilotModel[];
}

function groupAndSort(data: CopilotModel[]): VendorGroup[] {
  const map = new Map<string, CopilotModel[]>();

  for (const model of data) {
    const vendor = model.vendor ?? "Unknown";
    const list = map.get(vendor);
    if (list) {
      list.push(model);
    } else {
      map.set(vendor, [model]);
    }
  }

  // Sort models within each group by max_context_window_tokens descending
  const groups: VendorGroup[] = [];
  for (const [vendor, models] of map) {
    models.sort((a, b) => {
      const ap = a.capabilities.limits?.max_context_window_tokens ?? 0;
      const bp = b.capabilities.limits?.max_context_window_tokens ?? 0;
      return bp - ap;
    });
    groups.push({ vendor, models });
  }

  // Sort vendor groups alphabetically
  groups.sort((a, b) => a.vendor.localeCompare(b.vendor));

  return groups;
}

export function CopilotModelsContent({ data }: CopilotModelsContentProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const loading = isPending || isRefreshing;

  const groups = useMemo(() => groupAndSort(data), [data]);

  async function handleRefresh() {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      await fetch("/api/copilot/models?refresh=true");
      startTransition(() => router.refresh());
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {data.length} model{data.length !== 1 ? "s" : ""} across{" "}
          {groups.length} vendor{groups.length !== 1 ? "s" : ""}
        </p>
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

      {refreshError && (
        <p className="text-xs text-destructive">{refreshError}</p>
      )}

      {groups.map(({ vendor, models }) => (
        <div key={vendor} className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{vendor}</h2>
            <Badge variant="secondary">{models.length}</Badge>
          </div>

          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[22%]">Model ID</TableHead>
                <TableHead className="hidden sm:table-cell w-[15%]">Name</TableHead>
                <TableHead className="hidden xl:table-cell w-[8%]">Version</TableHead>
                <TableHead className="hidden xl:table-cell w-[11%]">Family</TableHead>
                <TableHead className="hidden md:table-cell w-[7%]">Type</TableHead>
                <TableHead className="w-[11%] text-right">Context</TableHead>
                <TableHead className="hidden sm:table-cell w-[10%] text-right">Max Output</TableHead>
                <TableHead className="hidden lg:table-cell w-[8%]">Picker</TableHead>
                <TableHead className="hidden lg:table-cell w-[8%]">Preview</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model, i) => (
                <TableRow key={`${model.id}-${i}`}>
                  <TableCell className="truncate">
                    <span className="inline-flex items-center gap-1.5 max-w-full">
                      <span className="font-mono text-xs truncate">{model.id}</span>
                      <CopyButton text={model.id} />
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell font-medium truncate">{model.name}</TableCell>
                  <TableCell className="hidden xl:table-cell text-muted-foreground truncate">
                    {model.version}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell truncate">{model.capabilities.family}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="secondary">
                      {model.capabilities.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {model.capabilities.limits?.max_context_window_tokens?.toLocaleString() ??
                      "-"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-right font-mono text-xs">
                    {model.capabilities.limits?.max_output_tokens?.toLocaleString() ??
                      "-"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {model.model_picker_enabled ? (
                      <Badge variant="success">Yes</Badge>
                    ) : (
                      <Badge variant="secondary">No</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {model.preview_state ? (
                      <Badge variant="info">{model.preview_state}</Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </>
  );
}

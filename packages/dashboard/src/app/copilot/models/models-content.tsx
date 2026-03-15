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
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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

  // Sort models within each group by max_prompt_tokens descending
  const groups: VendorGroup[] = [];
  for (const [vendor, models] of map) {
    models.sort((a, b) => {
      const ap = a.capabilities.limits?.max_prompt_tokens ?? 0;
      const bp = b.capabilities.limits?.max_prompt_tokens ?? 0;
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

  const loading = isPending || isRefreshing;

  const groups = useMemo(() => groupAndSort(data), [data]);

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await fetch("/api/copilot/models?refresh=true");
      startTransition(() => router.refresh());
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

      {groups.map(({ vendor, models }) => (
        <div key={vendor} className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{vendor}</h2>
            <Badge variant="secondary">{models.length}</Badge>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Family</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Max Prompt</TableHead>
                <TableHead className="text-right">Max Output</TableHead>
                <TableHead>Picker</TableHead>
                <TableHead>Preview</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-xs">{model.id}</span>
                      <CopyButton text={model.id} />
                    </span>
                  </TableCell>
                  <TableCell className="font-medium">{model.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {model.version}
                  </TableCell>
                  <TableCell>{model.capabilities.family}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {model.capabilities.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {model.capabilities.limits?.max_prompt_tokens?.toLocaleString() ??
                      "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {model.capabilities.limits?.max_output_tokens?.toLocaleString() ??
                      "-"}
                  </TableCell>
                  <TableCell>
                    {model.model_picker_enabled ? (
                      <Badge variant="success">Yes</Badge>
                    ) : (
                      <Badge variant="secondary">No</Badge>
                    )}
                  </TableCell>
                  <TableCell>
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

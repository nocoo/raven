"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
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

export function CopilotModelsContent({ data }: CopilotModelsContentProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loading = isPending || isRefreshing;

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
          {data.length} model{data.length !== 1 ? "s" : ""} available
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
          {data.map((model) => (
            <TableRow key={model.id}>
              <TableCell className="font-mono text-xs">{model.id}</TableCell>
              <TableCell className="font-medium">{model.name}</TableCell>
              <TableCell className="text-muted-foreground">
                {model.version}
              </TableCell>
              <TableCell>{model.capabilities.family}</TableCell>
              <TableCell>
                <Badge variant="secondary">{model.capabilities.type}</Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {model.capabilities.limits?.max_prompt_tokens?.toLocaleString() ?? "-"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {model.capabilities.limits?.max_output_tokens?.toLocaleString() ?? "-"}
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
    </>
  );
}

"use client";

import { useState } from "react";
import { Settings2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ColumnDef {
  key: string;
  label: string;
  defaultVisible: boolean;
}

/** All available columns for the request table. */
export const ALL_COLUMNS: ColumnDef[] = [
  { key: "timestamp", label: "Time", defaultVisible: true },
  { key: "model", label: "Model", defaultVisible: true },
  { key: "status", label: "Status", defaultVisible: true },
  { key: "latency_ms", label: "Latency", defaultVisible: true },
  { key: "ttft_ms", label: "TTFT", defaultVisible: true },
  { key: "tokens", label: "Tokens", defaultVisible: true },
  { key: "stream", label: "Stream", defaultVisible: true },
  { key: "path", label: "Path", defaultVisible: true },
  // Extended columns (hidden by default)
  { key: "client_format", label: "Format", defaultVisible: false },
  { key: "strategy", label: "Strategy", defaultVisible: false },
  { key: "upstream", label: "Upstream", defaultVisible: false },
  { key: "account_name", label: "Account", defaultVisible: false },
  { key: "client_name", label: "Client", defaultVisible: false },
  { key: "session_id", label: "Session", defaultVisible: false },
  { key: "status_code", label: "Status Code", defaultVisible: false },
  { key: "processing_ms", label: "Processing", defaultVisible: false },
  { key: "stop_reason", label: "Stop Reason", defaultVisible: false },
  { key: "tool_call_count", label: "Tool Calls", defaultVisible: false },
  { key: "routing_path", label: "Routing", defaultVisible: false },
  { key: "translated_model", label: "Translated Model", defaultVisible: false },
  { key: "error_message", label: "Error", defaultVisible: false },
];

export function getDefaultVisibleColumns(): Set<string> {
  return new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));
}

interface ColumnConfigProps {
  visibleColumns: Set<string>;
  onToggle: (key: string) => void;
}

export function ColumnConfig({ visibleColumns, onToggle }: ColumnConfigProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-label="Configure columns"
        aria-expanded={open}
      >
        <Settings2 className="size-3.5 mr-1.5" />
        Columns
      </Button>

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border bg-popover p-1 shadow-md">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Toggle columns
            </div>
            {ALL_COLUMNS.map((col) => (
              <button
                key={col.key}
                onClick={() => onToggle(col.key)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent transition-colors"
                role="menuitemcheckbox"
                aria-checked={visibleColumns.has(col.key)}
              >
                <span className="size-3.5 flex items-center justify-center">
                  {visibleColumns.has(col.key) && <Check className="size-3" />}
                </span>
                {col.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

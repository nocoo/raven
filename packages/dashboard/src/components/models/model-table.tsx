import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import type { ModelStats } from "@/lib/types";
import { formatCompact, formatLatency } from "@/lib/chart-config";

interface ModelTableProps {
  data: ModelStats[];
}

export function ModelTable({ data }: ModelTableProps) {
  return (
    <div className="bg-secondary rounded-card p-4">
      <h3 className="text-sm font-medium mb-3">Model Details</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Total Tokens</TableHead>
            <TableHead className="text-right">Avg Latency</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                No model data available
              </TableCell>
            </TableRow>
          ) : (
            data.map((model) => (
              <TableRow key={model.model}>
                <TableCell className="font-mono text-xs">{model.model}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {model.count.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {formatCompact(model.total_tokens)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {formatLatency(model.avg_latency_ms)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

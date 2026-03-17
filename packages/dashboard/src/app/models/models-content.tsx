"use client";

import { useState, useEffect, useMemo } from "react";
import { ModelPie } from "@/components/models/model-pie";
import { ModelBar } from "@/components/models/model-bar";
import { ModelTable } from "@/components/models/model-table";
import { MODEL_TOP_N } from "@/lib/chart-config";
import type { ModelStats } from "@/lib/types";

interface ModelsContentProps {
  data: ModelStats[];
}

/** Build a unified top-N set: any model that appears in the top-N by count
 *  OR by total_tokens is kept individually; the rest are merged into "Others". */
function unifyTopN(data: ModelStats[]): ModelStats[] {
  if (data.length <= MODEL_TOP_N) return data;

  const topByCount = new Set(
    [...data].sort((a, b) => b.count - a.count).slice(0, MODEL_TOP_N).map((m) => m.model),
  );
  const topByTokens = new Set(
    [...data].sort((a, b) => b.total_tokens - a.total_tokens).slice(0, MODEL_TOP_N).map((m) => m.model),
  );
  const keepSet = new Set([...topByCount, ...topByTokens]);

  const kept: ModelStats[] = [];
  const rest: ModelStats[] = [];
  for (const m of data) {
    if (keepSet.has(m.model)) kept.push(m);
    else rest.push(m);
  }

  if (rest.length === 0) return kept;

  const others: ModelStats = {
    model: `Others (${rest.length})`,
    count: rest.reduce((s, m) => s + m.count, 0),
    total_tokens: rest.reduce((s, m) => s + m.total_tokens, 0),
    avg_latency_ms:
      rest.length > 0
        ? rest.reduce((s, m) => s + m.avg_latency_ms, 0) / rest.length
        : 0,
  };
  return [...kept, others];
}

export function ModelsContent({ data }: ModelsContentProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const unified = useMemo(() => unifyTopN(data), [data]);

  return (
    <>
      {mounted ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ModelPie data={unified} />
          <ModelBar data={unified} />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="bg-secondary rounded-card p-4 h-[268px]" />
          <div className="bg-secondary rounded-card p-4 h-[268px]" />
        </div>
      )}
      <ModelTable data={data} />
    </>
  );
}

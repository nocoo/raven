import { MODEL_TOP_N } from "@/lib/chart-config";
import type { ModelStats } from "@/lib/types";

/** Build a unified top-N set: any model that appears in the top-N by count
 *  OR by total_tokens is kept individually; the rest are merged into "Others". */
export function unifyTopN(data: ModelStats[]): ModelStats[] {
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

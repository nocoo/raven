/**
 * Chart configuration and utilities
 * Provides unified color palette, axis settings, and formatters for recharts
 */

// ── Color palette (CSS custom properties from globals.css) ──

/** Helper — wraps a CSS custom property name for inline style usage. */
const v = (token: string) => `hsl(var(--${token}))`;

const chart = {
  blue:      v("chart-1"),  // Brand slate-blue (= --primary)
  sky:       v("chart-2"),
  teal:      v("chart-3"),
  jade:      v("chart-4"),
  green:     v("chart-5"),
  lime:      v("chart-6"),
  amber:     v("chart-7"),
  orange:    v("chart-8"),
  cobalt:    v("chart-9"),
  red:       v("chart-10"),
  rose:      v("chart-11"),
  magenta:   v("chart-12"),
  orchid:    v("chart-13"),
  purple:    v("chart-14"),
  indigo:    v("chart-15"),
  navy:      v("chart-16"),
  steel:     v("chart-17"),
  cadet:     v("chart-18"),
  seafoam:   v("chart-19"),
  olive:     v("chart-20"),
  gold:      v("chart-21"),
  tangerine: v("chart-22"),
  crimson:   v("chart-23"),
  gray:      v("chart-24"),
} as const;

/** Ordered array — use for pie / donut / bar where you need N colors by index. */
const PALETTE_COLORS = Object.values(chart);

const chartAxis = v("chart-axis");
const chartMuted = v("chart-muted");

// ── Public API ──

/**
 * CHART_COLORS — semantic color map built from the CSS-variable palette.
 */
export const CHART_COLORS = {
  palette: PALETTE_COLORS,
  primary: PALETTE_COLORS[0]!,   // slate-blue
  success: PALETTE_COLORS[4]!,   // green
  warning: PALETTE_COLORS[6]!,   // amber
  danger: PALETTE_COLORS[9]!,    // red
  muted: chartMuted,
} as const;

/**
 * Get color from palette by index (wraps around)
 */
export function getChartColor(index: number): string {
  return PALETTE_COLORS[index % PALETTE_COLORS.length]!;
}

/**
 * Common axis configuration — uses CSS variable tokens
 */
export const AXIS_CONFIG = {
  tick: { fontSize: 12, fill: chartAxis },
  axisLine: false as const,
  tickLine: false as const,
} as const;

/**
 * Common tooltip styles (for custom tooltip components)
 *
 * @deprecated Use the `<ChartTooltip>` / `<ChartTooltipRow>` /
 * `<ChartTooltipSummary>` atoms from
 * `components/dashboard/chart-tooltip.tsx`. Kept temporarily for legacy
 * panels; will be removed once import count = 0.
 * See docs/22-dashboard-design-system.md (Rule 6).
 */
export const TOOLTIP_STYLES = {
  container: "rounded-md border bg-popover px-3 py-2 text-sm shadow-md",
  title: "font-medium",
  value: "text-muted-foreground",
} as const;

/**
 * Common bar radius for rounded corners
 */
export const BAR_RADIUS = {
  horizontal: [0, 4, 4, 0] as [number, number, number, number],
  vertical: [4, 4, 0, 0] as [number, number, number, number],
} as const;

/**
 * Format number compactly (for axis labels and stat cards)
 */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return value.toLocaleString();
}

/**
 * Format percentage
 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format milliseconds as human-readable latency
 */
export function formatLatency(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/**
 * Format a timestamp bucket (epoch ms) as HH:MM for chart axis labels
 */
export function formatBucketTime(bucket: number): string {
  const d = new Date(bucket);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/**
 * Shared ResponsiveContainer props to avoid repeated configuration.
 * - minWidth/minHeight=0: prevent flex/grid sizing issues
 * - initialDimension={1,1}: suppress recharts -1 initial size warning
 * - debounce=150: throttle resize callbacks to avoid jank during
 *   sidebar collapse/expand animation (also 150ms)
 */
export const RESPONSIVE_CONTAINER_PROPS = {
  width: "100%" as const,
  height: "100%" as const,
  minWidth: 0,
  minHeight: 0,
  initialDimension: { width: 1, height: 1 },
  debounce: 150,
} as const;

/**
 * Standard chart heights for consistent layout
 */
export const CHART_HEIGHTS = {
  /** Full-size charts: model pie, model bar */
  full: 280,
  /** Standard charts: request volume, tokens, latency */
  standard: 220,
  /** Compact sparklines: logs sidebar mini-charts */
  compact: 140,
} as const;

/**
 * Pie chart label line configuration
 */
export const PIE_LABEL_LINE = {
  stroke: chartMuted,
  strokeWidth: 1,
} as const;

/**
 * Maximum number of individual items to show in model distribution
 * charts. Remaining items are aggregated into an "Others" bucket.
 */
export const MODEL_TOP_N = 8;

/**
 * Disable recharts built-in animations.
 * Default is 1500ms ease from origin — too slow for a real-time dashboard.
 * Spread onto every <Line>, <Area>, <Bar>, <Pie> element.
 */
export const ANIMATION_PROPS = {
  isAnimationActive: false,
} as const;

# 22 — Dashboard Design System

> Tighten visual consistency across the Raven dashboard while keeping the
> Basalt design language. Lock in 6 hard rules, ship them through a short
> docs → tokens → sample → batch loop, and add lightweight visualization to
> a few previously table-only pages.

## Status: Draft

## Goal & Non-Goal

**Goal**

- Unify card hierarchy, typography, dividers, table density, and chart
  primitives across every dashboard page so that nothing looks "off-brand".
- Promote the currently-unused **L1** surface (`bg-card`) so the
  page → outer card → nested surface → overlay hierarchy is visible.
- Make a few low-information pages (`providers`, `copilot/account`,
  `copilot/models`, `settings`) less of a wall of text by adding small
  visualization cards that reuse data we already fetch.

**Non-Goal**

- Re-skin the dashboard. Raven currently scores **98/100** on the babaco
  tracker (`babaco-basalt-project-tracker`, 2026-05-01) — the design
  language is not in question. This is a pass for *consistency and
  hierarchy*, not a redesign.
- Introduce new API queries to enrich pages. Visualization additions must
  re-use existing endpoints / already-fetched data; if the underlying data
  is missing, the chart is deferred, not the query added.
- Touch backend, telemetry, or data model.

## Source of Truth

- **External memory** (nmem CLI):
  - `ccstudio-basalt-4-tier-brightness` — canonical 4-tier luminance rule
  - `babaco-basalt-project-tracker` — current scoring (raven = 98)
- **In-repo reference**:
  - Token definitions: `packages/dashboard/src/app/globals.css`
  - Existing chart primitives: `packages/dashboard/src/lib/chart-config.ts`
  - Existing stat primitive: `packages/dashboard/src/components/stats/stat-card.tsx`

## The 6 Hard Rules

### Rule 1 — Luminance: 3 persistent layers + L3 overlay

Per Basalt, raven exposes four tokens but only three are persistent surfaces;
L3 is overlay-only and never paints a permanent page background.

| Layer | Token | Where |
|-------|-------|-------|
| **L0** | `bg-background` | Page body, sidebar, header, outer wrapper |
| **L1** | `bg-card` + `rounded-card` | Each section's outermost card |
| **L2** | `bg-secondary` | Chart containers, table surfaces, inner / nested cards |
| **L3** | `bg-popover` + `border` + `shadow-lg` | Tooltip, dropdown, sheet, drawer, hover-card — overlays only |

**Constraints**

- L3 is **overlay only** — never use as a permanent surface.
- For the **page main structure** the order is `L0 → L1 → L2 → L3`.
  The "no L0→L2 jump" rule applies to that structural spine; small
  controls, skeletons, and icon backgrounds are not bound by it.

### Rule 2 — Typography: 6 semantic classes (with strict edges)

| Class | Equivalent | Use only for | Do NOT use for |
|-------|-----------|--------------|-----------------|
| `text-display` | `text-2xl md:text-3xl font-semibold font-display tracking-tight` | Page H1 | Card titles |
| `text-section` | `text-base md:text-lg font-semibold font-display` | Card / panel main title | Table headers, small labels |
| `text-card-label` | `text-xs md:text-sm text-muted-foreground` | Card small label, table header | Body text |
| `text-body` | `text-sm` | Body content | Numeric columns |
| `text-meta` | `text-xs text-muted-foreground` | Subtitle, timestamp, hint | Card titles |
| `text-numeric` | `text-sm font-medium tabular-nums` | Numeric table column, stat values | Free text |

`text-section` must not creep into table cells or small labels. If a label
fits in `text-card-label`, do not promote it to `text-section`.

### Rule 3 — Card hierarchy (migrate, do not sweep)

| Variant | Class string |
|---------|--------------|
| Primary card (L1) | `rounded-card bg-card p-4 md:p-5` |
| Nested card (L2) | `rounded-card bg-secondary p-3 md:p-4` |
| Compact card (L2) | `rounded-widget bg-secondary p-2 md:p-3` |
| Page spacing | `space-y-4 md:space-y-6`, grids `gap-3 md:gap-4` |

**Migration rule** — **do not** mass-replace `bg-secondary` → `bg-card`.
Per page: outer stat / analytics / settings group = `bg-card`; inner chart
container, table surface, sub-grouping = `bg-secondary`. The Overview page
is the sample; subsequent batches follow that structure.

### Rule 4 — Divider: 3 fixed shades

| Use | Class |
|-----|-------|
| Main divider, card boundary | `border-border` |
| Table row divider | `border-border/50` |
| Nested / subtle divider | `border-border/30` |

`border-border/40` and `border-border/60` are **removed**.

### Rule 5 — Table density: default + two exceptions

| Density | Padding | When |
|---------|---------|------|
| **default** | `px-3 py-2.5` | Analytics, breakdown, standard list |
| **compact** | `px-3 py-2` | Logs, events, high-density streaming list |
| **comfortable** | `px-4 py-3` | Settings, form-driven list |

Header cells: `text-card-label font-medium`. Numeric columns:
`text-numeric text-right`.

### Rule 6 — Chart primitives (3-piece set, additive rollout)

- **Axis ticks**: read from `AXIS_CONFIG` (`lib/chart-config.ts`).
  Inline `fontSize` on `<XAxis>` / `<YAxis>` is banned.
- **Grid**: new `<DashboardCartesianGrid />` defaulting to
  `strokeDasharray="3 3" strokeOpacity={0.15} vertical={false}`.
- **Tooltip**: new `<ChartTooltip>` / `<ChartTooltipRow>` /
  `<ChartTooltipSummary>` atoms replace per-panel `<div>` markup.

`TOOLTIP_STYLES` (the existing string-record export) is marked
`@deprecated`. Sample + new panels use the new component; legacy panels
migrate as they are touched. The export is removed only when the import
count reaches zero, to keep DS-1 diff small.

## Anti-patterns (deduct examples from babaco-basalt-project-tracker)

- Missing `rounded-card` on a primary card → −1
- Missing `tabular-nums` on a numeric column → −1
- Painting a permanent surface with `bg-popover` → block
- Skipping L1 (page → bg-secondary directly) on a section's outer card → block
- Inline `fontSize` on chart axis ticks → block

## Rollout Plan (short closed loops)

| Phase | Scope | Exit |
|-------|-------|------|
| **DS-0** | This document | Reviewed by codex, agreed by zheng-li |
| **DS-1** | Register typography utilities in `globals.css`; mark `TOOLTIP_STYLES` deprecated. Build smoke (`bun run build` + typecheck). Fall back to `export const` strings if Tailwind v4 utility merging is unstable. | Build green |
| **DS-2** | Sample page: Overview (`app/page.tsx`). Apply all 6 rules. | Light + dark desktop screenshot in one message; mobile screenshot separately; 3-line change summary. Codex pass. |
| **DS-3** | Batch analytics pages: `requests`, `logs`, `sessions`, `models`. Density chosen per page type (default vs compact). | Per-page atomic commit. |
| **DS-4** | Batch tools pages: `clients`, `providers`, `connect`, `copilot/account`, `copilot/models`. | Per-page atomic commit. |
| **DS-5** | Settings: main + `proxy`, `server-tools`, `upstreams`, plus inline (`debug`, `ip-whitelist`, `optimizations`, `socks5`, `sound`). Comfortable density. | Per-page atomic commit. |
| **PG-Visual** | First wave only: `providers` (request distribution donut + uptime sparkline), `copilot/account` (quota bar + 7d sparkline), `copilot/models` (top-models bar + tokens stat), `settings` main (status overview tiles). No new API queries. | Per-page atomic commit. |
| **PG-Polish** | Skeleton heights match real card height; reduced-motion respected; dark-mode contrast spot-check. | One commit. |

## Verification

- `bun run build` green for `packages/dashboard`
- `bun run typecheck` green
- `bun test` (dashboard package) green
- Visual: light + dark spot-check on every modified page
- Final code review by `@codexstudio` before push

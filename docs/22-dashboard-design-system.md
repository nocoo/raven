# 22 — Dashboard Hierarchy and Disclosure

Updated 2026-09-23 for the Raven 2.8 dashboard.

## Design authority

Use the installed Basalt 2.1.8 `ai/INTEGRATION.md`, component registry and
declarations. The matching Basalt checkout was reviewed at
`5dda9f82eb3c768a6b0d8723496ffd2ad5ce6af7`.
This document records Raven's composition choices, not a separate token system.

## Surfaces

| Level | Component | Token |
| --- | --- | --- |
| L0 | Viewport and sidebar | `--basalt-background` |
| L1 | ContentIsland and portal dialog roots | `--basalt-card` |
| L2 | First LayerCard under the island | `--basalt-secondary` |
| L3 | Nested LayerCard or LayerCard.Well | `--basalt-bright` |
| Overlay | Popover, tooltip and dropdown | `--basalt-popover` |

Keep one island. Layout grids and sections do not paint or reset the surface
root. Use card luminance and spacing for grouping; avoid extra wrapper cards.
Controls retain Basalt's surface-relative fill and state borders.

Analytics panels use a compact L2 heading and L3 data area. Statistics remain
single-surface tiles. Loading placeholders follow the same geometry.

## Navigation and page frame

Sidebar groups are the source of truth for the header trail and current page
name, not URL prefixes. Examples: Settings → General, Settings → Connect,
Tools → Server Tools, Copilot → Account. Group labels have no destination and
are not links. The compact mobile header shows the current page name.

Every Dashboard destination fills the available island width. AppShell owns
one full-width frame, including headings, tabs, errors and loading states.
Navigation metadata does not select a width mode. Readability constraints
belong to fields inside cards, never to a page or tab container.

| Family | Routes | Composition |
| --- | --- | --- |
| Analytics | Overview, Models, API Keys | Metric tiles and spanning chart cards |
| Data tables | Requests, Copilot Models | Full-width table cards |
| Configuration | General, Proxy, Server Tools | Peer task cards |
| Account and access | Account, Connect | Summary, configuration and detail cards |
| Routing | Upstreams, Routing Rules | Compact directory and a fluid card-based editor |

## Grouping

Configuration sections use the shared `settings-grid`: exactly two equal peer
columns when their container reaches 57rem, one otherwise. They do not grow
into three or four columns on ultrawide displays. General, Proxy, Server Tools,
Account details, Upstream connections and Connect examples follow this rule.
The upstream editor establishes its own query container after the directory.
Cards use natural height and compact spacing, without artificial equal-height
fill or extra surface layers.

Each task owns one card header with its title, state and local actions. Do not
put a SectionRule around a single titled card; retain region headings only for
groups such as account quotas. Form bodies may cap field width while the card
continues to fill its grid track. Numeric and short-text controls stay compact.
Proxy Save is a page action because it persists both connection and policies;
the enable switch belongs to the connection card.

Routing places a compact directory beside the editor. The selected entry has
an accent surface and stronger foreground text. Editor title, save actions and tabs sit
directly on the island; targets, connection details, model catalog, diagnostics,
quota and period overrides own their cards. Removing the editor's outer card
keeps a scheduled target within the visible L2/L3 stack.

General pairs version overrides with request optimizations, and IP
restrictions with CORS. Narrow layouts stack in the same reading order.
Connect places an endpoint card beside a code-example card at wide widths.
Endpoint rows share one surface; model selection lives with its example.
Client setup guides and protocol details are separately disclosed on demand.

Use 12–16px internal/group spacing, compact controls, and ordinary text of at
least 11px. Long descriptions should stay near the control they explain.

## Decorative accents

Use the shared `SectionIcon` for compact Lucide marks in task-card headings and
routing directories. Its 28px tinted tile contains a 16px, 1.5-stroke icon.
Reuse Basalt's palette: blue for connections, teal for access/capabilities,
purple for configuration/models, and orange for usage/time/optimization.
Account summary tiles use the same treatment. Do not add banner-sized artwork,
extra card nesting or full-card color washes.

These marks are decorative and hidden from assistive technology; headings keep
their text names. Color identifies a topic, never an enabled/healthy state.
State badges, switches and explicit warning text remain independent. Both
themes inherit the library tokens without per-page color overrides.

## Progressive disclosure

- Show the current task before optional explanations or later steps.
- Routing starts with the default target; schedule and conversion live in
  their own tabs. Explain quota advancement only when multiple targets exist.
- Connection overrides start collapsed unless saved settings differ from
  their defaults. Keep API-key preservation hints beside the key field.
- Enabling a quota reveals its allowance, reset and multiplier controls.
- Empty, disabled IP/CORS details start collapsed. Users can expand and edit
  restrictions before enabling them. Existing entries remain visible by
  default; successful enable opens the configuration.
- Keep save errors outside collapsed content. Do not hide security warnings
  required to understand an active option.
- Put protocol classification and connection edge cases behind named
  disclosures. Avoid repeating the same instruction in headings, hints and
  footers.
- Proxy keeps connection fields first, with optional authentication and
  routing overrides disclosed separately. Saved overrides remain visible.
- Server Tools allows API-key setup before enabling the tool. Missing-key
  warnings and save errors stay outside the disclosure.
- Account starts with subscription and quota. Capabilities appear once;
  endpoints, tracking metadata and token-refresh diagnostics are optional.
- Use Basalt Collapsible for height transitions and keyboard semantics.
  Respect reduced motion; do not add mandatory tours or animation delays.

## Charts

Reuse Basalt chart configuration, palettes and frame/tooltip primitives.
Keep domain formatting and aggregation in Raven. Chart labels and legends
must explain values without relying solely on color. Layout work must preserve
filters, raw model IDs, stable key identities and request drill-down links.

## Verification

Run the required repository hooks, Dashboard coverage, lint, types and build.
Use `bun run scripts/verify-routing-ui.ts` after a production build for isolated
routing, quota, upstream, key-binding and request workflows.

Visual checks cover all twelve sidebar destinations at 2560, 1920, 1280 and 390px,
light/dark themes, navigation/title consistency, full-width alignment, collapsed
navigation, disclosure focus, scrolling and reduced motion. Daily development
screenshots use `https://raven.dev.hexly.ai`; write interactions use synthetic
fixtures. These bounded checks do not establish complete L2/L3/D1 coverage.

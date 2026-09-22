# 27 · Monitor Dashboard

Monitor follows the investigation path from overall health to a model or API
key, then to the requests responsible for a signal. It uses the existing
Basalt, Recharts, SQLite analytics and shared log stream.

## Pages

| Page | Purpose | Main drilldown |
| --- | --- | --- |
| Overview `/` | Request volume, errors, latency, TTFT, tokens and native share | Time bucket, model, key, protocol, slow calls or failures |
| Models `/models` | Model workload over time, calling keys and protocol distribution | Select a model, then a key or matching requests |
| API Keys `/keys` | When a key was active, models called, latency and protocol paths | Select a stable key identity, then a model or time bucket |
| Requests `/requests` | Filter, sort, paginate and inspect individual calls | Protocol route, timing, key, model, client, session and live logs |

The separate Clients, Sessions and Providers monitor tables are removed. Client,
session and upstream filters remain available in Requests and investigation
links. Upstream configuration remains under Settings; token Sentinel status is
under Copilot Account, including when account-info loading fails.

Each ranking row combines request count, tokens, P95 latency, errors and native
share. Overview totals describe the full selection, even when a ranking only
shows its top entries. Empty model identifiers are displayed without a link
that would accidentally clear the model filter.

## Protocol meaning

| Mode | Recorded evidence |
| --- | --- |
| Native | `copilot-native`, `copilot-openai-direct`, `copilot-responses`, `custom-anthropic`; `custom-openai` with OpenAI input and no translated model |
| Translated | `copilot-translated`, `copilot-chat-via-responses`; `custom-openai` with Anthropic input and a recorded translated model |
| Unknown | Missing, contradictory or insufficient route telemetry |

Server-tool interception records the base strategy and upstream format. Older
tool records may omit the strategy; an explicit `native` or `translated` routing
path supplies the mode only when the strategy is empty.
The separate `server_tools_used` field identifies those requests in the drawer.

Native means the client and upstream use the same API protocol. It does not
promise byte-for-byte payload or SSE passthrough. Chat Completions to Responses
is translation even though both are OpenAI APIs. Unknown requests remain in the
native-share denominator; an empty selection has no percentage.

The Dashboard describes implemented routes. Anthropic requests can use an
OpenAI upstream with responses translated back; an OpenAI client to an
Anthropic-only upstream remains unsupported. Messages to Responses remains a
design, not an implemented route. The separate protocol repair series and its
verification limits are recorded in the [architecture audit](proxy-architecture.html).

## Key identity

Authentication carries the database key ID through context, strategies,
stream completion, server-tool interception and route rejection to the request
sink. Requests store `api_key_id`, never a key secret or hash. Reserved identities
`env:default`, `internal` and `dev` distinguish non-database credentials.

The analytics identity is the stored ID, or `legacy:<account_name>` for rows
written before key IDs were recorded. Two current keys with the same name remain
separate, including after revocation, deletion or reuse of a name. Historical
name groups are explicitly labeled as ambiguous; their IDs are never inferred
from current key names. First and last activity refer to the selected time range.

The identity expression is shared by queries, filters and the SQLite index on
identity plus timestamp. A query-plan regression test verifies indexed lookup
for key drilldowns.

## Filters and data flow

URL parameters carry time, model, key, protocol and the existing request filters
between pages, including sidebar navigation. Selecting an identity removes only
the dimension being replaced. Pagination and sort state are not carried into a
new investigation. Bucket links clamp to the displayed time window and use an
inclusive upper bound one millisecond before the next bucket.

All Monitor timelines and request timestamps use labeled UTC. This also avoids
server/client hydration failures when browser/server time zones or Intl date
punctuation differ. Ranges spanning multiple days show dates on the time axis.
Missing time buckets have zero traffic and no latency sample. Chart series use
internal property names so dots or brackets in a model ID cannot become a
Recharts property path.

`lib/monitor-data.ts` loads one consistent time window with eight parallel API
reads for Overview and nine for a usage explorer. Model/key selector rankings
omit only their own dimension; other panels stay scoped. Rankings are bounded
at 50 and activity at six top series plus Others. Named partial-load warnings
distinguish unavailable data from zero traffic. Rendering reuses the app's
shared log stream instead of opening a connection per panel.

The root layout owns the application shell, so route transitions retain the
sidebar, header, navigation state and log dock. Each page has a route-level
`loading.tsx` with a matching skeleton: Monitor summaries and charts, request
tables, account cards, or settings forms. Loading states announce the target
page without exposing placeholder controls, and respect reduced motion.

Persisted input counters mean uncached input. The headline token sum is labeled
uncached input plus output; cache read/write counters appear separately in the
composition chart. These counters are not a billing estimate.

## Verification

- Proxy unit and in-process route tests cover protocol classification,
  cross-filter summaries/breakdowns/series, stable key identity and the sink.
- `test/routes/key-telemetry.test.ts` follows real auth middleware through the
  seven strategies to in-memory SQLite with mocked upstreams. It covers both
  custom-OpenAI modes, native/translated stream completion, server tools, router
  rejection, duplicate names, revoked/deleted keys and indexed drilldowns.
- Dashboard tests cover filter preservation, safe URL encoding, bounded time
  buckets, chart gaps, dotted model IDs, unknown denominators, historical key
  labels, loader failures and request-time consistency across time zones.
- The production bundle is checked in Chrome against a temporary in-memory
  proxy fixture with 640 synthetic requests. No daily data or model upstream is
  used for the populated browser checks.
- Delayed fixture responses verify skeletons on all 11 Dashboard routes,
  persistent sidebar/header nodes and collapsed state, a single log connection,
  interrupted navigation and the 390px mobile layout. Unit tests verify that
  route fallbacks announce the destination without interactive placeholders.
- Normal local preview and manual verification use
  **https://raven.dev.hexly.ai**, through the existing Caddy mapping to port 7023.

The declared coverage scope and stronger proxy baseline remain unchanged;
removed page paths are removed from the obsolete coverage exclusions. The eight
reported protocol defects now have passing ordinary regressions; the architecture
audit records each repair commit and the remaining limits of that evidence.

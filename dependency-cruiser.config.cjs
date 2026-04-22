/**
 * Architectural layering enforcement (§4.5 / §8).
 *
 * Phase A.3: skeleton only — zero active rules. Rules are activated
 * incrementally as layers solidify:
 *   - D.7  protocols/ boundary
 *   - E.11 upstream/ boundary + infra/state access rule
 *   - H.19 strategies/ boundary (partial: core/ ↛ strategies|upstream;
 *           strategies/*.ts ↛ infra/state)
 *   - J.7  final full layering check (routes/ ↛ strategies|upstream)
 *
 * See docs/20-architecture-refactor.md §3.7 for the canonical
 * state-access rule and §8 for the enforcement plan.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-is-concretion-free",
      comment:
        "H.19 (partial): core/ defines the abstract Strategy/Runner/router contracts (§3.7). It must never reach into specific strategy or upstream implementations — those live in composition/ and below. The full §3.8 contract (routes/ ↛ strategies|upstream, composition/ as sole bridge) lands in J.7 once route handlers stop importing payload types directly.",
      severity: "error",
      from: { path: "^packages/proxy/src/core/" },
      to: {
        path: [
          "^packages/proxy/src/strategies/",
          "^packages/proxy/src/upstream/",
        ],
      },
    },
    {
      name: "strategies-are-state-free",
      comment:
        "H.19 (partial): strategies/*.ts (the per-strategy factories) read no infra/state — the composition root injects state-derived flags via factory deps (§3.7). strategies/support/ may still touch state for now (folded into Phase J).",
      severity: "error",
      from: {
        path: "^packages/proxy/src/strategies/[^/]+\\.ts$",
      },
      to: {
        path: [
          "^packages/proxy/src/infra/state",
          "^packages/proxy/src/lib/state",
        ],
      },
    },
    {
      name: "protocols-are-pure",
      comment:
        "Phase D.7: protocols/ is the pure zone (§3.7). It must never reach into state, logging, or Hono streaming primitives. Those are impure concerns that live in strategies/support/ or routes/. A redundant grep check in CI acts as belt-and-braces; this rule is authoritative (path-aware, immune to ../../ aliasing).",
      severity: "error",
      from: { path: "^packages/proxy/src/protocols/" },
      to: {
        path: [
          "^packages/proxy/src/infra/state",
          "^packages/proxy/src/lib/state",
          "^packages/proxy/src/util/log-emitter",
          "^packages/proxy/src/util/logger",
          "^hono/streaming$",
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(node_modules|\\.bun|coverage|dist|\\.next|test/|__tests__/)",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}

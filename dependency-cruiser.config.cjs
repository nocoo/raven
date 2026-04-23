/**
 * Architectural layering enforcement (§4.5 / §8).
 *
 * J.7 (final): activates the full §3.7 + §3.8 contract that holds against
 * the post-Phase-J code — concretion-free core/, pure protocols/, state-free
 * strategy concretions, and composition/ as the sole bridge between
 * routes/, strategies/, and upstream/. Route handlers still read
 * `lib/state` directly for state-derived flags (providers, feature gates);
 * moving that behind a composition-supplied context is out of scope for
 * this refactor and intentionally NOT enforced here.
 *
 * See docs/20-architecture-refactor.md §3.7 for the canonical
 * state-access rule and §3.8 for the composition-root contract.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-is-concretion-free",
      comment:
        "J.7 (§3.7 / §3.8): core/ defines the abstract Strategy / Runner / router contracts. It must never reach into specific strategy or upstream implementations — those live in composition/ and below. Promoted from H.19 partial to final.",
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
        "J.7 (§3.7): per-strategy factories (strategies/*.ts) read no state singleton. State-derived values flow in via composition-injected BuildStrategyDeps. strategies/support/ remains exempt — it is the impure-helper layer authorised by §3.7 to touch infra/state alongside infra/, composition/, and util/.",
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
        "J.7 (§3.7): protocols/ is the pure zone — no state, no logging, no Hono streaming. Impure concerns belong in strategies/support/ or routes/. A redundant grep check in CI acts as belt-and-braces; this rule is authoritative.",
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
    {
      name: "routes-no-strategies-concrete",
      comment:
        "J.7 (§3.8): routes/ reaches strategies/ only through composition/. Type-only imports (UpReq shapes needed to build dispatch inputs) are allowed; value imports are not. strategies/support/ remains importable for cross-cutting helpers like decorate() until Phase J's handler-thinning follow-up.",
      severity: "error",
      from: { path: "^packages/proxy/src/routes/" },
      to: {
        path: "^packages/proxy/src/strategies/[^/]+\\.ts$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "routes-no-upstream-concrete",
      comment:
        "J.7 (§3.8): routes/ reaches upstream/ only through composition/upstream-registry. Type-only imports (payload shapes for building requests) are allowed; value imports are not.",
      severity: "error",
      from: { path: "^packages/proxy/src/routes/" },
      to: {
        path: "^packages/proxy/src/upstream/",
        dependencyTypesNot: ["type-only"],
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

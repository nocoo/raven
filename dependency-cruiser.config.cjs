/**
 * Architectural layering enforcement (§4.5 / §8).
 *
 * Phase A.3: skeleton only — zero active rules. Rules are activated
 * incrementally as layers solidify:
 *   - D.7  protocols/ boundary
 *   - E.11 upstream/ boundary + infra/state access rule
 *   - H.19 strategies/ boundary
 *   - J.7  final full layering check
 *
 * See docs/20-architecture-refactor.md §3.7 for the canonical
 * state-access rule and §8 for the enforcement plan.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [],
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

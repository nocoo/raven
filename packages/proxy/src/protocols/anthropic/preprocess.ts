/**
 * protocols/anthropic — pure helpers for the Anthropic wire protocol.
 *
 * A.5 seeds this directory with `translateModelName` and its
 * co-located regex constants. D.1 will move the rest of the legacy
 * `routes/messages/preprocess.ts` helpers here and delete the
 * routes/messages re-export shim.
 *
 * These helpers must stay pure — no imports from `lib/state`,
 * `db/`, or any side-effecting module. The canonical layering rule
 * in docs/20-architecture-refactor.md §3.7 is enforced by
 * dep-cruiser once §8 rules activate (D.7 onward).
 */

// Pre-compiled regexes for model name translation (avoid regex compilation on each call)
const MODEL_REGEX_WITH_MINOR =
  /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:(?:-|\[)(1m|fast)\]?)?(?:-\d{8})?$/
const MODEL_REGEX_NO_MINOR = /^(claude-(?:opus|sonnet|haiku))-(\d+)(?:-\d{8})?$/

/**
 * Translate Anthropic SDK model identifiers to Copilot model IDs.
 *
 * Copilot uses dot-separated versions without date suffixes:
 * - `claude-opus-4-6-20250820` → `claude-opus-4.6`
 * - `claude-opus-4-6` + `anthropic-beta: context-1m-*` → `claude-opus-4.6-1m`
 * - `claude-opus-4-6[1m]` → `claude-opus-4.6-1m`
 * - `claude-sonnet-4-5-20250514` → `claude-sonnet-4.5`
 * - `claude-sonnet-4-20250514` → `claude-sonnet-4`
 *
 * This function is ONLY used for Copilot routing. Custom providers receive
 * the original model name unchanged.
 */
export function translateModelName(model: string, anthropicBeta: string | null): string {
  const betas = anthropicBeta?.split(",").map((b) => b.trim()) ?? []
  const wants1m = betas.some((b) => b.startsWith("context-1m-"))
  const wantsFast = betas.some((b) => b.startsWith("fast-mode-"))

  const match = model.match(MODEL_REGEX_WITH_MINOR)
  if (match) {
    const [, family, major, minor, suffix] = match
    const base = `${family}-${major}.${minor}`
    if (suffix) return `${base}-${suffix}`
    if (wants1m) return `${base}-1m`
    if (wantsFast) return `${base}-fast`
    return base
  }

  const matchNoMinor = model.match(MODEL_REGEX_NO_MINOR)
  if (matchNoMinor) {
    const [, family, major] = matchNoMinor
    return `${family}-${major}`
  }

  return model
}

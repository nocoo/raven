import { z } from "zod"
import { normalizeIntervals } from "../core/schedule.ts"
import { RoutingError, type QuotaPolicy, type RoutingRuleInput } from "../core/routing-types.ts"

const name = z.string().trim().min(1).max(128)
const model = z.string().refine((value) => value.trim().length > 0, "Model ID must be nonempty")
const mode = z.enum(["all_day", "daily", "weekly"])
const interval = {
  id: z.string().trim().min(1),
  start_minute: z.number().int(),
  end_minute: z.number().int(),
}
const target = z.strictObject({ upstream_id: z.string().min(1), model: model.refine((value) => value !== "auto", "auto is reserved") })
const chain = z.array(target).min(1)

export const quotaSchema = z.strictObject({
  limit_tokens: z.number().positive(),
  window_minutes: z.number().positive().refine((value) => Number.isSafeInteger(value * 60000), "Window duration must resolve to integer milliseconds"),
  next_reset_at: z.number().int().refine(Number.isSafeInteger),
  mode,
  multipliers: z.array(z.strictObject({ ...interval, multiplier: z.number().positive() })),
})

const providerFields = {
  name,
  base_url: z.url().refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, "Upstream URL must use HTTP(S), without credentials, query or fragment"),
  format: z.enum(["anthropic_messages", "chat_completions", "responses"]),
  api_key: z.string().min(1),
  is_enabled: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  auth_style: z.enum(["x-api-key", "bearer"]).nullable().optional(),
  use_socks5: z.boolean().nullable().optional(),
  manual_models: z.array(model).optional(),
  quota: quotaSchema.nullable().optional(),
}

export const createProviderSchema = z.strictObject(providerFields)
export const updateProviderSchema = createProviderSchema.partial()
export const routingRuleSchema = z.strictObject({
  name,
  allow_conversion: z.boolean().optional(),
  mode,
  default_chain: chain,
  periods: z.array(z.strictObject({ ...interval, targets: chain })),
})

export const createKeySchema = z.strictObject({ name: z.string().trim().min(1).max(64), rule_id: z.string().min(1) })
export const updateKeySchema = z.strictObject({ rule_id: z.string().min(1) })

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new RoutingError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return result.data
}

function validateFragmentIdentity<T extends { id: string }>(fragments: readonly T[], payload: (fragment: T) => unknown): void {
  const identities = new Map<string, string>()
  for (const fragment of fragments) {
    const value = JSON.stringify(payload(fragment))
    const existing = identities.get(fragment.id)
    if (existing !== undefined && existing !== value) throw new RoutingError("Fragments of a logical period must have identical settings")
    identities.set(fragment.id, value)
  }
}

export function validateQuota(input: unknown): QuotaPolicy {
  const policy = parseInput(quotaSchema, input)
  policy.multipliers = normalizeIntervals(policy.mode, policy.multipliers)
  validateFragmentIdentity(policy.multipliers, (fragment) => fragment.multiplier)
  return policy
}

export function validateRule(input: unknown): RoutingRuleInput {
  const rule = parseInput(routingRuleSchema, input)
  rule.periods = normalizeIntervals(rule.mode, rule.periods)
  validateFragmentIdentity(rule.periods, (fragment) => fragment.targets)
  return { ...rule, allow_conversion: rule.allow_conversion ?? false }
}

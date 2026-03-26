import { Hono } from "hono"
import { z } from "zod"
import type { Database } from "bun:sqlite"

import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
} from "~/db/providers"
import { cacheProviders } from "~/lib/utils"
import { state } from "~/lib/state"
import type { CreateProviderInput, UpdateProviderInput } from "~/db/providers"

// ===========================================================================
// Validation schemas
// ===========================================================================

const createProviderSchema = z.object({
  name: z.string().min(1).max(100),
  base_url: z.string().url(),
  format: z.enum(["openai", "anthropic"]),
  api_key: z.string().min(1),
  model_patterns: z.array(z.string()).min(1),
  is_enabled: z.boolean().optional().default(true),
})

const updateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  base_url: z.string().url().optional(),
  format: z.enum(["openai", "anthropic"]).optional(),
  api_key: z.string().min(1).optional(),
  model_patterns: z.array(z.string()).min(1).optional(),
  is_enabled: z.boolean().optional(),
})

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Check if any of the given model patterns conflict with:
 * 1. Copilot models (from state.models)
 * 2. Existing providers (excluding the provider being updated)
 * Returns array of conflicting model names.
 */
function checkModelConflicts(
  db: Database,
  patterns: string[],
  excludeProviderId: string | null = null,
): string[] {
  const conflicts: string[] = []

  // Check against Copilot models
  if (state.models?.data) {
    for (const pattern of patterns) {
      if (pattern.includes("*")) {
        // Glob pattern
        const prefix = pattern.slice(0, -1)
        const conflicting = state.models.data.filter((m) => m.id.startsWith(prefix))
        for (const model of conflicting) {
          if (!conflicts.includes(model.id)) conflicts.push(model.id)
        }
      } else {
        // Exact pattern
        const conflicting = state.models.data.find((m) => m.id === pattern)
        if (conflicting && !conflicts.includes(pattern)) {
          conflicts.push(pattern)
        }
      }
    }
  }

  // Check against other providers (including disabled ones since they can be re-enabled)
  const allProviders = db
    .query("SELECT id, model_patterns, enabled FROM providers")
    .all() as Array<{ id: string; model_patterns: string; enabled: number }>

  for (const other of allProviders) {
    if (excludeProviderId && other.id === excludeProviderId) continue

    try {
      const otherPatterns: string[] = JSON.parse(other.model_patterns)
      for (const pattern of patterns) {
        for (const otherPattern of otherPatterns) {
          // Check for exact match
          if (pattern === otherPattern) {
            if (!conflicts.includes(pattern)) conflicts.push(pattern)
            continue
          }
          // Check for glob match: pattern=exact, otherPattern=glob (e.g. "glm-5" vs "glm-*")
          if (otherPattern.includes("*")) {
            const prefix = otherPattern.slice(0, -1)
            if (pattern.startsWith(prefix)) {
              if (!conflicts.includes(pattern)) conflicts.push(pattern)
            }
          }
          // Check for glob match: pattern=glob, otherPattern=exact (e.g. "glm-*" vs "glm-5")
          if (pattern.includes("*")) {
            const prefix = pattern.slice(0, -1)
            if (otherPattern.startsWith(prefix)) {
              if (!conflicts.includes(otherPattern)) conflicts.push(otherPattern)
            }
          }
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return conflicts
}

// ===========================================================================
// Route factory
// ===========================================================================

export function createUpstreamsRoute(db: Database): Hono {
  const app = new Hono()

  // GET /upstreams — list all providers
  app.get("/upstreams", (c) => {
    const providers = listProviders(db)
    return c.json(providers)
  })

  // GET /upstreams/:id — get one provider
  app.get("/upstreams/:id", (c) => {
    const id = c.req.param("id")
    const provider = getProvider(db, id)
    if (!provider) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }
    return c.json(provider)
  })

  // POST /upstreams — create provider
  app.post("/upstreams", async (c) => {
    let input: CreateProviderInput
    try {
      input = createProviderSchema.parse(await c.req.json())
    } catch {
      return c.json({ error: { message: "Invalid input" } }, 400)
    }

    // Check for model conflicts
    const conflicts = checkModelConflicts(db, input.model_patterns)
    if (conflicts.length > 0) {
      return c.json(
        {
          error: {
            message: `Model conflicts with existing models: ${conflicts.join(", ")}`,
            type: "model_conflict",
            conflicts,
          },
        },
        409,
      )
    }

    const provider = createProvider(db, input)

    // Refresh state so new provider is immediately routable
    cacheProviders(db)

    return c.json(provider, 201)
  })

  // PUT /upstreams/:id — update provider
  app.put("/upstreams/:id", async (c) => {
    const id = c.req.param("id")
    const existing = getProvider(db, id)
    if (!existing) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    let input: UpdateProviderInput
    try {
      const parsed = updateProviderSchema.parse(await c.req.json())
      // Filter out undefined values for exactOptionalPropertyTypes compatibility
      input = Object.fromEntries(
        Object.entries(parsed).filter(([_, v]) => v !== undefined),
      ) as UpdateProviderInput
    } catch {
      return c.json({ error: { message: "Invalid input" } }, 400)
    }

    // Check for model conflicts (exclude current provider)
    const conflicts = checkModelConflicts(
      db,
      input.model_patterns ?? existing.model_patterns,
      id,
    )
    if (conflicts.length > 0) {
      return c.json(
        {
          error: {
            message: `Model conflicts with existing models: ${conflicts.join(", ")}`,
            type: "model_conflict",
            conflicts,
          },
        },
        409,
      )
    }

    const updated = updateProvider(db, id, input)
    if (!updated) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    // Refresh state
    cacheProviders(db)

    return c.json(updated)
  })

  // DELETE /upstreams/:id — delete provider
  app.delete("/upstreams/:id", (c) => {
    const id = c.req.param("id")
    const existing = getProvider(db, id)
    if (!existing) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    deleteProvider(db, id)

    // Refresh state
    cacheProviders(db)

    return c.json({ success: true })
  })

  return app
}

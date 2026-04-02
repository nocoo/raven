import { Hono } from "hono"
import { z } from "zod"
import type { Database } from "bun:sqlite"

import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
} from "./../db/providers"
import { cacheProviders } from "./../lib/utils"
import { state } from "./../lib/state"
import type { CreateProviderInput, UpdateProviderInput } from "./../db/providers"

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
  supports_reasoning: z.boolean().optional().default(false),
})

const updateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  base_url: z.string().url().optional(),
  format: z.enum(["openai", "anthropic"]).optional(),
  api_key: z.string().min(1).optional(),
  model_patterns: z.array(z.string()).min(1).optional(),
  is_enabled: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
})

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Check if any of the given model patterns conflict with:
 * 1. Copilot models (from state.models) - exact patterns only
 * 2. Existing providers (excluding the provider being updated) - exact patterns only
 *
 * NOTE: Glob patterns (e.g., "glm-*") are allowed to overlap with exact patterns.
 * The routing logic uses exact-first matching, so globs serve as fallbacks.
 *
 * Returns array of conflicting model names.
 */
function checkModelConflicts(
  db: Database,
  patterns: string[],
  excludeProviderId: string | null = null,
): string[] {
  const conflicts: string[] = []

  // Check exact patterns against Copilot models
  if (state.models?.data) {
    for (const pattern of patterns) {
      // Skip glob patterns - they're allowed as fallbacks
      if (pattern.includes("*")) continue

      // Exact pattern: check for conflict
      const conflicting = state.models.data.find((m) => m.id === pattern)
      if (conflicting && !conflicts.includes(pattern)) {
        conflicts.push(pattern)
      }
    }
  }

  // Check exact patterns against other providers
  const allProviders = db
    .query("SELECT id, model_patterns, enabled FROM providers")
    .all() as Array<{ id: string; model_patterns: string; enabled: number }>

  for (const other of allProviders) {
    if (excludeProviderId && other.id === excludeProviderId) continue

    try {
      const otherPatterns: string[] = JSON.parse(other.model_patterns)
      for (const pattern of patterns) {
        // Skip glob patterns - they're allowed as fallbacks
        if (pattern.includes("*")) continue

        for (const otherPattern of otherPatterns) {
          // Skip glob patterns - they're allowed as fallbacks
          if (otherPattern.includes("*")) continue

          // Exact-to-exact conflict
          if (pattern === otherPattern && !conflicts.includes(pattern)) {
            conflicts.push(pattern)
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
    // Block if Copilot models aren't loaded (conflict detection would be incomplete)
    if (!state.models?.data) {
      return c.json(
        {
          error: {
            message: "Cannot create provider: Copilot models not loaded. Conflict detection against Copilot models is unavailable.",
            type: "service_unavailable",
          },
        },
        503,
      )
    }

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

    // Block if updating model_patterns and Copilot models aren't loaded
    if (input.model_patterns !== undefined && !state.models?.data) {
      return c.json(
        {
          error: {
            message: "Cannot update model patterns: Copilot models not loaded. Conflict detection against Copilot models is unavailable.",
            type: "service_unavailable",
          },
        },
        503,
      )
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

  // GET /upstreams/:id/models — health check + list models from upstream
  app.get("/upstreams/:id/models", async (c) => {
    const id = c.req.param("id")

    // Get full provider record (with api_key) from DB
    const row = db
      .query("SELECT * FROM providers WHERE id = $id")
      .get({ $id: id }) as import("./../db/providers").ProviderRecord | null

    if (!row) {
      return c.json({ error: { message: "Provider not found" } }, 404)
    }

    // Build models endpoint URL
    const baseUrl = row.base_url.replace(/\/+$/, "")
    const modelsUrl = `${baseUrl}/v1/models`

    try {
      const res = await fetch(modelsUrl, {
        headers: {
          Authorization: `Bearer ${row.api_key}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10000), // 10s timeout
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        return c.json(
          {
            error: {
              message: `Upstream returned ${res.status}: ${text.slice(0, 200)}`,
              type: "upstream_error",
            },
            healthy: false,
          },
          502,
        )
      }

      const data = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> }
      const models = data.data ?? []

      // Group models by owned_by
      const grouped: Record<string, string[]> = {}
      for (const model of models) {
        const owner = model.owned_by ?? "unknown"
        if (!grouped[owner]) grouped[owner] = []
        grouped[owner].push(model.id)
      }

      // Sort models within each group
      for (const owner of Object.keys(grouped)) {
        grouped[owner]!.sort()
      }

      return c.json({
        healthy: true,
        total: models.length,
        models: grouped,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      return c.json(
        {
          error: {
            message: `Failed to connect: ${message}`,
            type: "connection_error",
          },
          healthy: false,
        },
        502,
      )
    }
  })

  return app
}

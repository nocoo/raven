import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import {
  initProviders,
  createProvider,
  listProviders,
  getProvider,
  updateProvider,
  deleteProvider,
  getEnabledProviders,
} from "../../src/db/providers"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  initProviders(db)
})

afterEach(() => {
  db.close()
})

describe("initProviders", () => {
  test("creates providers table", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
      .all()
    expect(tables.length).toBe(1)
  })

  test("is idempotent", () => {
    initProviders(db)
    initProviders(db)
    // No error
  })
})

describe("createProvider", () => {
  test("stores record in DB", () => {
    const input = {
      name: "Zhipu GLM",
      base_url: "https://open.bigmodel.cn/api/anthropic",
      format: "anthropic" as const,
      api_key: "sk-test-key",
      model_patterns: ["glm-5", "glm-*"],
    }
    const result = createProvider(db, input)

    expect(result.id).toBeTruthy()
    expect(result.name).toBe("Zhipu GLM")
    expect(result.base_url).toBe("https://open.bigmodel.cn/api/anthropic")
    expect(result.format).toBe("anthropic")
    expect(result.api_key_preview).toBe("sk-test-...****") // first 8 of "sk-test-key"
    expect(result.model_patterns).toEqual(["glm-5", "glm-*"])
    expect(result.is_enabled).toBe(true)
    expect(result.created_at).toBeGreaterThan(0)
    expect(result.updated_at).toBe(result.created_at)
  })

  test("stores empty model_patterns as empty array", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: [],
    })
    expect(result.model_patterns).toEqual([])
  })

  test("defaults enabled to true", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })
    expect(result.is_enabled).toBe(true)
  })

  test("respects is_enabled: false", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      is_enabled: false,
    })
    expect(result.is_enabled).toBe(false)
  })

  test("generates unique ids", () => {
    const a = createProvider(db, {
      name: "A",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })
    const b = createProvider(db, {
      name: "B",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })
    expect(a.id).not.toBe(b.id)
  })

  test("accepts both valid formats", () => {
    const anthropic = createProvider(db, {
      name: "Anthropic Provider",
      base_url: "https://api.anthropic.com",
      format: "anthropic",
      api_key: "key",
      model_patterns: ["claude-3-5-sonnet-20241022"],
    })
    expect(anthropic.format).toBe("anthropic")

    const openai = createProvider(db, {
      name: "OpenAI Provider",
      base_url: "https://api.openai.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["gpt-4"],
    })
    expect(openai.format).toBe("openai")
  })
})

describe("listProviders", () => {
  test("returns empty array when no providers", () => {
    expect(listProviders(db)).toEqual([])
  })

  test("returns all providers ordered by created_at ASC", () => {
    const first = createProvider(db, {
      name: "First",
      base_url: "https://first.com",
      format: "openai",
      api_key: "key1",
      model_patterns: ["model1"],
    })

    // Simulate time passing
    const now = Date.now()
    db.query("UPDATE providers SET created_at = $created_at WHERE id = $id").run({
      $created_at: now - 1000,
      $id: first.id,
    })

    createProvider(db, {
      name: "Second",
      base_url: "https://second.com",
      format: "openai",
      api_key: "key2",
      model_patterns: ["model2"],
    })

    const providers = listProviders(db)
    expect(providers.length).toBe(2)
    expect(providers[0]?.name).toBe("First")
    expect(providers[1]?.name).toBe("Second")
  })

  test("includes disabled providers", () => {
    createProvider(db, {
      name: "Enabled",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      is_enabled: true,
    })
    createProvider(db, {
      name: "Disabled",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      is_enabled: false,
    })

    const providers = listProviders(db)
    expect(providers.length).toBe(2)
    expect(providers[0]?.is_enabled).toBe(true)
    expect(providers[1]?.is_enabled).toBe(false)
  })

  test("masks api_key", () => {
    createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "sk-secret-key-12345",
      model_patterns: ["model"],
    })

    const providers = listProviders(db)
    expect(providers[0]?.api_key_preview).toBe("sk-secre...****")
    expect(providers[0]).not.toHaveProperty("api_key")
  })
})

describe("getProvider", () => {
  test("returns provider by id", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })

    const found = getProvider(db, created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe("Test")
  })

  test("returns null for nonexistent id", () => {
    const found = getProvider(db, "nonexistent")
    expect(found).toBeNull()
  })
})

describe("updateProvider", () => {
  test("updates specified fields", () => {
    const created = createProvider(db, {
      name: "Original",
      base_url: "https://original.com",
      format: "openai",
      api_key: "original-key",
      model_patterns: ["model1"],
      is_enabled: true,
    })

    const updated = updateProvider(db, created.id, {
      name: "Updated",
      base_url: "https://updated.com",
      is_enabled: false,
    })

    expect(updated).not.toBeNull()
    expect(updated!.name).toBe("Updated")
    expect(updated!.base_url).toBe("https://updated.com")
    expect(updated!.format).toBe("openai") // unchanged
    expect(updated!.api_key_preview).toBe("original...****") // unchanged
    expect(updated!.model_patterns).toEqual(["model1"]) // unchanged
    expect(updated!.is_enabled).toBe(false)
    expect(updated!.updated_at).toBeGreaterThanOrEqual(created.updated_at)
  })

  test("updates model_patterns", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model1"],
    })

    const updated = updateProvider(db, created.id, {
      model_patterns: ["model2", "model3"],
    })

    expect(updated!.model_patterns).toEqual(["model2", "model3"])
  })

  test("updates api_key", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "original-key",
      model_patterns: ["model"],
    })

    const updated = updateProvider(db, created.id, {
      api_key: "new-key",
    })

    expect(updated!.api_key_preview).toBe("new-key...****")
  })

  test("returns null for nonexistent id", () => {
    const result = updateProvider(db, "nonexistent", { name: "New" })
    expect(result).toBeNull()
  })

  test("toggles is_enabled", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      is_enabled: true,
    })

    let updated = updateProvider(db, created.id, { is_enabled: false })
    expect(updated!.is_enabled).toBe(false)

    updated = updateProvider(db, created.id, { is_enabled: true })
    expect(updated!.is_enabled).toBe(true)
  })
})

describe("deleteProvider", () => {
  test("removes provider from DB", () => {
    const created = createProvider(db, {
      name: "ToDelete",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })

    const ok = deleteProvider(db, created.id)
    expect(ok).toBe(true)
    expect(listProviders(db)).toEqual([])
  })

  test("returns false for nonexistent id", () => {
    const ok = deleteProvider(db, "nonexistent")
    expect(ok).toBe(false)
  })
})

describe("getEnabledProviders", () => {
  test("returns only enabled providers", () => {
    createProvider(db, {
      name: "Enabled",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      is_enabled: true,
    })
    createProvider(db, {
      name: "Disabled",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      is_enabled: false,
    })

    const enabled = getEnabledProviders(db)
    expect(enabled.length).toBe(1)
    expect(enabled[0]?.name).toBe("Enabled")
  })

  test("returns empty array when no providers", () => {
    expect(getEnabledProviders(db)).toEqual([])
  })

  test("returns records with raw api_key", () => {
    createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "secret-key-12345",
      model_patterns: ["model"],
    })

    const enabled = getEnabledProviders(db)
    expect(enabled[0]?.api_key).toBe("secret-key-12345")
  })

  test("orders by created_at ASC", () => {
    const p1 = createProvider(db, {
      name: "First",
      base_url: "https://first.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })
    // Simulate p1 being created earlier
    db.query("UPDATE providers SET created_at = $created_at WHERE id = $id").run({
      $created_at: p1.created_at - 1000,
      $id: p1.id,
    })

    createProvider(db, {
      name: "Second",
      base_url: "https://second.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })

    const enabled = getEnabledProviders(db)
    expect(enabled[0]?.name).toBe("First")
    expect(enabled[1]?.name).toBe("Second")
  })
})

describe("api_key masking", () => {
  test("masks short keys (shows full key + ellipsis)", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "short",
      model_patterns: ["model"],
    })
    expect(result.api_key_preview).toBe("short...****")
  })

  test("masks empty key as ****", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "",
      model_patterns: ["model"],
    })
    expect(result.api_key_preview).toBe("****")
  })

  test("masks 8-char keys as full key + ...****", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "12345678",
      model_patterns: ["model"],
    })
    expect(result.api_key_preview).toBe("12345678...****")
  })

  test("masks long keys with first 8 chars", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "sk-secret-key-12345",
      model_patterns: ["model"],
    })
    expect(result.api_key_preview).toBe("sk-secre...****")
  })
})

describe("supports_reasoning field", () => {
  test("createProvider defaults supports_reasoning to false", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })
    expect(result.supports_reasoning).toBe(false)
  })

  test("createProvider accepts supports_reasoning: true", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["o1*"],
      supports_reasoning: true,
    })
    expect(result.supports_reasoning).toBe(true)
  })

  test("createProvider accepts supports_reasoning: false explicitly", () => {
    const result = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      supports_reasoning: false,
    })
    expect(result.supports_reasoning).toBe(false)
  })

  test("updateProvider can toggle supports_reasoning to true", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
    })
    expect(created.supports_reasoning).toBe(false)

    const updated = updateProvider(db, created.id, { supports_reasoning: true })
    expect(updated!.supports_reasoning).toBe(true)
  })

  test("updateProvider can toggle supports_reasoning to false", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["o1*"],
      supports_reasoning: true,
    })
    expect(created.supports_reasoning).toBe(true)

    const updated = updateProvider(db, created.id, { supports_reasoning: false })
    expect(updated!.supports_reasoning).toBe(false)
  })

  test("updateProvider preserves supports_reasoning when not specified", () => {
    const created = createProvider(db, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["o1*"],
      supports_reasoning: true,
    })

    const updated = updateProvider(db, created.id, { name: "Updated" })
    expect(updated!.supports_reasoning).toBe(true)
  })

  test("getEnabledProviders returns supports_reasoning in record", () => {
    createProvider(db, {
      name: "Reasoning",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["o1*"],
      supports_reasoning: true,
    })

    const enabled = getEnabledProviders(db)
    expect(enabled[0]?.supports_reasoning).toBe(1)
  })

  test("listProviders returns supports_reasoning as boolean", () => {
    createProvider(db, {
      name: "Reasoning",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["o1*"],
      supports_reasoning: true,
    })
    createProvider(db, {
      name: "Non-Reasoning",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["gpt-4"],
    })

    const providers = listProviders(db)
    expect(providers[0]?.supports_reasoning).toBe(true)
    expect(providers[1]?.supports_reasoning).toBe(false)
  })

  test("migration adds column to existing table without error", () => {
    // Create a fresh DB and run init twice to verify safeAddColumn is idempotent
    const db2 = new Database(":memory:")
    initProviders(db2)
    initProviders(db2)  // Should not throw

    // Verify the column exists by inserting with supports_reasoning
    const result = createProvider(db2, {
      name: "Test",
      base_url: "https://example.com",
      format: "openai",
      api_key: "key",
      model_patterns: ["model"],
      supports_reasoning: true,
    })
    expect(result.supports_reasoning).toBe(true)
    db2.close()
  })
})

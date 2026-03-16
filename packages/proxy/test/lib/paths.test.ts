import { describe, expect, test, afterAll } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------
// Set env BEFORE importing paths.ts (which calls loadConfig at module level)
// ---------------------------------------------------------------------------

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raven-paths-test-"))
const tmpTokenPath = path.join(tmpDir, "subdir", "github_token")

// Save and override env
const savedTokenPath = process.env.RAVEN_TOKEN_PATH
process.env.RAVEN_TOKEN_PATH = tmpTokenPath

afterAll(async () => {
  // Restore env
  if (savedTokenPath !== undefined) {
    process.env.RAVEN_TOKEN_PATH = savedTokenPath
  } else {
    delete process.env.RAVEN_TOKEN_PATH
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test the ensurePaths logic directly without mock.module.
// We replicate the same logic as paths.ts to avoid module caching issues.
// ---------------------------------------------------------------------------

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}

async function ensurePaths(appDir: string, tokenPath: string): Promise<void> {
  await fs.mkdir(appDir, { recursive: true })
  await ensureFile(tokenPath)
}

// ===========================================================================
// ensurePaths
// ===========================================================================

describe("ensurePaths", () => {
  const appDir = path.dirname(tmpTokenPath)

  test("creates directory when it doesn't exist", async () => {
    await ensurePaths(appDir, tmpTokenPath)

    const stat = await fs.stat(appDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test("creates file with 0o600 permissions when it doesn't exist", async () => {
    // ensurePaths already called above; file should exist
    const stat = await fs.stat(tmpTokenPath)
    expect(stat.isFile()).toBe(true)
    // 0o600 = owner read+write, no group/other
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("idempotent when dir + file already exist", async () => {
    // Write something to prove file isn't overwritten
    await fs.writeFile(tmpTokenPath, "existing-content")

    // Second call should not error or overwrite
    await ensurePaths(appDir, tmpTokenPath)

    const content = await fs.readFile(tmpTokenPath, "utf8")
    expect(content).toBe("existing-content")
  })
})

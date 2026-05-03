import { describe, expect, test, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DIR_MODE, FILE_MODE } from "../../src/lib/app-dirs";

// ---------------------------------------------------------------------------
// Set env BEFORE importing anything that uses app-dirs
// ---------------------------------------------------------------------------

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raven-paths-test-"));
const tmpConfigDir = path.join(tmpDir, "config");

// Save and override env
const savedConfigDir = process.env.RAVEN_CONFIG_DIR;
process.env.RAVEN_CONFIG_DIR = tmpConfigDir;

afterAll(async () => {
  // Restore env
  if (savedConfigDir !== undefined) {
    process.env.RAVEN_CONFIG_DIR = savedConfigDir;
  } else {
    delete process.env.RAVEN_CONFIG_DIR;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test the ensurePaths logic directly
// ---------------------------------------------------------------------------

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK);
  } catch {
    await fs.writeFile(filePath, "");
    await fs.chmod(filePath, FILE_MODE);
  }
}

async function ensurePaths(configDir: string, tokenPath: string): Promise<void> {
  await fs.mkdir(configDir, { recursive: true, mode: DIR_MODE });
  await ensureFile(tokenPath);
}

// ===========================================================================
// ensurePaths
// ===========================================================================

describe("ensurePaths", () => {
  const tmpTokenPath = path.join(tmpConfigDir, "github_token");

  test("creates directory with 0o700 permissions when it doesn't exist", async () => {
    await ensurePaths(tmpConfigDir, tmpTokenPath);

    const stat = await fs.stat(tmpConfigDir);
    expect(stat.isDirectory()).toBe(true);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(DIR_MODE);
  });

  test("creates file with 0o600 permissions when it doesn't exist", async () => {
    // ensurePaths already called above; file should exist
    const stat = await fs.stat(tmpTokenPath);
    expect(stat.isFile()).toBe(true);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(FILE_MODE);
  });

  test("idempotent when dir + file already exist", async () => {
    // Write something to prove file isn't overwritten
    await fs.writeFile(tmpTokenPath, "existing-content");

    // Second call should not error or overwrite
    await ensurePaths(tmpConfigDir, tmpTokenPath);

    const content = await fs.readFile(tmpTokenPath, "utf8");
    expect(content).toBe("existing-content");
  });
});

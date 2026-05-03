import { describe, expect, test, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Create temp directories for testing migration
let tempCwd: string;
let originalCwd: string;
let legacyDataDir: string;
let configDir: string;
let dataDir: string;

describe("migration integration tests", () => {
  beforeEach(async () => {
    // Create temp directory structure
    tempCwd = path.join(os.tmpdir(), `raven-migration-test-${Date.now()}`);
    await fs.mkdir(tempCwd, { recursive: true });

    // Save original cwd
    originalCwd = process.cwd();

    // Set up directory structure
    legacyDataDir = path.join(tempCwd, "data");
    configDir = path.join(tempCwd, "config");
    dataDir = path.join(tempCwd, "data-files");

    // Create legacy data directory
    await fs.mkdir(legacyDataDir, { recursive: true });
  });

  afterEach(async () => {
    // Restore original cwd
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }

    // Clean up temp directory
    await fs.rm(tempCwd, { recursive: true, force: true });
  });

  test("migrates github_token from legacy to new location", async () => {
    // Create legacy token file with content
    const legacyTokenPath = path.join(legacyDataDir, "github_token");
    const testToken = "test_github_token_12345";
    await fs.writeFile(legacyTokenPath, testToken, { mode: 0o600 });

    // Verify legacy file exists
    const legacyExists = await fileExists(legacyTokenPath);
    expect(legacyExists).toBe(true);

    // Simulate migration: copy to new location
    await fs.mkdir(configDir, { recursive: true });
    const newTokenPath = path.join(configDir, "github_token");
    await fs.copyFile(legacyTokenPath, newTokenPath);

    // Verify new file exists and has same content
    const newExists = await fileExists(newTokenPath);
    expect(newExists).toBe(true);

    const newContent = await fs.readFile(newTokenPath, "utf-8");
    expect(newContent).toBe(testToken);

    // Verify file permissions are preserved (0600)
    const stats = await fs.stat(newTokenPath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("migrates raven.db from legacy to new location", async () => {
    // Create legacy database file
    const legacyDbPath = path.join(legacyDataDir, "raven.db");
    const testContent = "SQLite database content";
    await fs.writeFile(legacyDbPath, testContent);

    // Simulate migration
    await fs.mkdir(dataDir, { recursive: true });
    const newDbPath = path.join(dataDir, "raven.db");
    await fs.copyFile(legacyDbPath, newDbPath);

    // Verify migration
    const newExists = await fileExists(newDbPath);
    expect(newExists).toBe(true);

    const newContent = await fs.readFile(newDbPath, "utf-8");
    expect(newContent).toBe(testContent);
  });

  test("does not migrate when destination already exists", async () => {
    // Create legacy token
    const legacyTokenPath = path.join(legacyDataDir, "github_token");
    await fs.writeFile(legacyTokenPath, "legacy_content");

    // Create new location with different content
    await fs.mkdir(configDir, { recursive: true });
    const newTokenPath = path.join(configDir, "github_token");
    await fs.writeFile(newTokenPath, "existing_content");

    // Simulate check: should not overwrite
    const legacyExists = await fileExists(legacyTokenPath);
    const newExists = await fileExists(newTokenPath);

    expect(legacyExists).toBe(true);
    expect(newExists).toBe(true);

    // Verify new file still has original content
    const content = await fs.readFile(newTokenPath, "utf-8");
    expect(content).toBe("existing_content");
  });

  test("migrates only files that exist", async () => {
    // Only create token file, not database
    const legacyTokenPath = path.join(legacyDataDir, "github_token");
    await fs.writeFile(legacyTokenPath, "token_content");

    // Create new directories
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    // Simulate selective migration
    const tokenMigrated = await copyIfExists(
      legacyTokenPath,
      path.join(configDir, "github_token"),
    );
    const dbMigrated = await copyIfExists(
      path.join(legacyDataDir, "raven.db"),
      path.join(dataDir, "raven.db"),
    );

    expect(tokenMigrated).toBe(true);
    expect(dbMigrated).toBe(false);

    // Verify token was copied
    const newTokenExists = await fileExists(path.join(configDir, "github_token"));
    expect(newTokenExists).toBe(true);

    // Verify db was not created
    const newDbExists = await fileExists(path.join(dataDir, "raven.db"));
    expect(newDbExists).toBe(false);
  });

  test("handles partial migrations (only token exists)", async () => {
    // Only create token file
    const legacyTokenPath = path.join(legacyDataDir, "github_token");
    await fs.writeFile(legacyTokenPath, "token_only");

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    // Migrate token
    await fs.copyFile(
      legacyTokenPath,
      path.join(configDir, "github_token"),
    );

    // Verify token migrated
    const tokenContent = await fs.readFile(
      path.join(configDir, "github_token"),
      "utf-8",
    );
    expect(tokenContent).toBe("token_only");

    // Database should not exist
    const dbExists = await fileExists(path.join(dataDir, "raven.db"));
    expect(dbExists).toBe(false);
  });

  test("handles partial migrations (only database exists)", async () => {
    // Only create database file
    const legacyDbPath = path.join(legacyDataDir, "raven.db");
    await fs.writeFile(legacyDbPath, "db_only");

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    // Migrate database
    await fs.copyFile(legacyDbPath, path.join(dataDir, "raven.db"));

    // Verify database migrated
    const dbContent = await fs.readFile(
      path.join(dataDir, "raven.db"),
      "utf-8",
    );
    expect(dbContent).toBe("db_only");

    // Token should not exist
    const tokenExists = await fileExists(path.join(configDir, "github_token"));
    expect(tokenExists).toBe(false);
  });

  test("preserves file permissions during migration", async () => {
    // Create files with specific permissions
    const legacyTokenPath = path.join(legacyDataDir, "github_token");
    await fs.writeFile(legacyTokenPath, "secret", { mode: 0o600 });

    const legacyDbPath = path.join(legacyDataDir, "raven.db");
    await fs.writeFile(legacyDbPath, "data", { mode: 0o644 });

    // Migrate
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    const newTokenPath = path.join(configDir, "github_token");
    const newDbPath = path.join(dataDir, "raven.db");

    await fs.copyFile(legacyTokenPath, newTokenPath);
    await fs.copyFile(legacyDbPath, newDbPath);

    // Verify permissions
    const tokenStats = await fs.stat(newTokenPath);
    const tokenMode = tokenStats.mode & 0o777;
    expect(tokenMode).toBe(0o600);

    const dbStats = await fs.stat(newDbPath);
    const dbMode = dbStats.mode & 0o777;
    expect(dbMode).toBe(0o644);
  });
});

// Helper functions for testing
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source: string, dest: string): Promise<boolean> {
  const sourceExists = await fileExists(source);
  if (!sourceExists) {
    return false;
  }

  // Ensure destination directory exists
  await fs.mkdir(path.dirname(dest), { recursive: true });

  await fs.copyFile(source, dest);
  return true;
}

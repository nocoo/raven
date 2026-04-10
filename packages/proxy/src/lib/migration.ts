/**
 * Legacy path migration support.
 *
 * Detects and migrates files from the old ./data/ directory to the new
 * platform-aware user directories. This runs once at startup.
 *
 * Migration rules:
 * - ./data/github_token → getConfigDir()/github_token
 * - ./data/raven.db → getDataDir()/raven.db
 * - Only migrate if source exists and destination doesn't
 * - Log all migration actions
 */

import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../util/logger";
import { getConfigDir, getDataDir, DIR_MODE } from "./app-dirs";

// Legacy paths (relative to cwd)
const LEGACY_DIR = "data";
const LEGACY_TOKEN_PATH = path.join(LEGACY_DIR, "github_token");
const LEGACY_DB_PATH = path.join(LEGACY_DIR, "raven.db");

/**
 * Check if a file or directory exists.
 */
async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists with correct permissions.
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: DIR_MODE });
}

/**
 * Migrate a single file from legacy to new location.
 */
async function migrateFile(
  source: string,
  dest: string,
  description: string,
): Promise<boolean> {
  const sourceExists = await exists(source);
  const destExists = await exists(dest);

  if (!sourceExists) {
    return false; // Nothing to migrate
  }

  if (destExists) {
    logger.info(`Skipping ${description} migration: destination already exists`, {
      source,
      dest,
    });
    return false;
  }

  try {
    // Ensure destination directory exists
    await ensureDir(path.dirname(dest));

    // Copy file to new location
    await fs.copyFile(source, dest);

    // For SQLite databases, also copy WAL (-wal) and SHM (-shm) files
    if (source.endsWith(".db")) {
      const walSource = source + "-wal";
      const shmSource = source + "-shm";
      const walDest = dest + "-wal";
      const shmDest = dest + "-shm";

      if (await exists(walSource)) {
        await fs.copyFile(walSource, walDest);
        logger.debug(`Migrated ${description}-wal`);
      }
      if (await exists(shmSource)) {
        await fs.copyFile(shmSource, shmDest);
        logger.debug(`Migrated ${description}-shm`);
      }
    }

    // Verify the copy was successful
    const destStats = await fs.stat(dest);
    if (!destStats.isFile()) {
      throw new Error("Destination is not a file after copy");
    }

    logger.info(`Migrated ${description}`, {
      from: source,
      to: dest,
    });

    return true;
  } catch (error) {
    logger.error(`Failed to migrate ${description}`, {
      source,
      dest,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Clean up legacy directory if it's empty.
 */
async function cleanupLegacyDir(): Promise<void> {
  try {
    const dirExists = await exists(LEGACY_DIR);
    if (!dirExists) return;

    const files = await fs.readdir(LEGACY_DIR);
    if (files.length === 0) {
      await fs.rmdir(LEGACY_DIR);
      logger.info(`Removed empty legacy directory: ${LEGACY_DIR}`);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Run all pending migrations.
 *
 * This should be called early in the startup process, after config is loaded
 * but before any services try to use the files.
 */
export async function runMigrations(): Promise<void> {
  const cwd = process.cwd();
  const legacyTokenFullPath = path.resolve(cwd, LEGACY_TOKEN_PATH);
  const legacyDbFullPath = path.resolve(cwd, LEGACY_DB_PATH);

  const configDir = getConfigDir();
  const dataDir = getDataDir();

  const newTokenPath = path.join(configDir, "github_token");
  const newDbPath = path.join(dataDir, "raven.db");

  // Check if we have any legacy files to migrate
  const hasLegacyToken = await exists(legacyTokenFullPath);
  const hasLegacyDb = await exists(legacyDbFullPath);

  if (!hasLegacyToken && !hasLegacyDb) {
    // No migration needed
    return;
  }

  logger.info("Legacy files detected, checking migration...", {
    legacyDir: LEGACY_DIR,
    configDir,
    dataDir,
  });

  // Migrate token file
  if (hasLegacyToken) {
    await migrateFile(legacyTokenFullPath, newTokenPath, "github_token");
  }

  // Migrate database
  if (hasLegacyDb) {
    await migrateFile(legacyDbFullPath, newDbPath, "raven.db");
  }

  // Clean up empty legacy directory
  await cleanupLegacyDir();

  logger.info("Migration complete. You can now remove the ./data directory if desired.");
}

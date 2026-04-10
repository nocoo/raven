import fs from "node:fs/promises";

import { loadConfig } from "../config";
import { getConfigDir, DIR_MODE, FILE_MODE } from "./app-dirs";

const config = loadConfig();
const APP_DIR = getConfigDir();
const GITHUB_TOKEN_PATH = config.tokenPath;

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
};

export async function ensurePaths(): Promise<void> {
  // Ensure config directory exists with correct permissions
  await fs.mkdir(APP_DIR, { recursive: true, mode: DIR_MODE });
  await ensureFile(GITHUB_TOKEN_PATH);
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK);
  } catch {
    await fs.writeFile(filePath, "");
    await fs.chmod(filePath, FILE_MODE);
  }
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * Read the version from the locally installed VS Code app.
 * Returns null if VS Code is not installed or the file cannot be read.
 */
export async function detectLocalVSCodeVersion(): Promise<string | null> {
  const packageJsonPath =
    "/Applications/Visual Studio Code.app/Contents/Resources/app/package.json";

  try {
    const raw = await readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the highest-version Copilot Chat extension installed locally.
 * Globs ~/.vscode/extensions/github.copilot-chat-*, sorts by semver,
 * and reads the version from its package.json.
 * Returns null if no extension is found.
 */
export async function detectLocalCopilotVersion(): Promise<string | null> {
  const extensionsDir = join(homedir(), ".vscode", "extensions");
  const glob = new Glob("github.copilot-chat-*/package.json");

  try {
    const matches: string[] = [];
    for await (const path of glob.scan({ cwd: extensionsDir })) {
      matches.push(path);
    }

    if (matches.length === 0) return null;

    // Extract versions and sort descending
    const versioned = matches
      .map((p) => {
        const match = p.match(/github\.copilot-chat-(\d+\.\d+\.\d+)/);
        return match ? { path: p, version: match[1] } : null;
      })
      .filter((v): v is { path: string; version: string } => v !== null)
      .sort((a, b) => compareSemver(b.version, a.version));

    if (versioned.length === 0) return null;

    // Read the actual version from the highest extension's package.json
    const fullPath = join(extensionsDir, versioned[0].path);
    const raw = await readFile(fullPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns negative if a < b, positive if a > b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

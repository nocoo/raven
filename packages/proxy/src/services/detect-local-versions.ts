import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

// ---------------------------------------------------------------------------
// VS Code app paths — per platform × editor variant
// ---------------------------------------------------------------------------

interface EditorCandidate {
  /** Path to the app's package.json containing `version`. */
  packageJson: string;
  /** Corresponding extensions dir for Copilot Chat lookup. */
  extensionsDir: string;
}

function getEditorCandidates(): EditorCandidate[] {
  const home = homedir();
  const os = platform();

  if (os === "darwin") {
    return [
      // VS Code
      {
        packageJson:
          "/Applications/Visual Studio Code.app/Contents/Resources/app/package.json",
        extensionsDir: join(home, ".vscode", "extensions"),
      },
      // VS Code Insiders
      {
        packageJson:
          "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/package.json",
        extensionsDir: join(home, ".vscode-insiders", "extensions"),
      },
      // Cursor
      {
        packageJson:
          "/Applications/Cursor.app/Contents/Resources/app/package.json",
        extensionsDir: join(home, ".cursor", "extensions"),
      },
      // VSCodium
      {
        packageJson:
          "/Applications/VSCodium.app/Contents/Resources/app/package.json",
        extensionsDir: join(home, ".vscode-oss", "extensions"),
      },
    ];
  }

  if (os === "linux") {
    return [
      // VS Code — snap, deb/rpm, or extracted
      {
        packageJson: "/usr/share/code/resources/app/package.json",
        extensionsDir: join(home, ".vscode", "extensions"),
      },
      {
        packageJson: "/snap/code/current/usr/share/code/resources/app/package.json",
        extensionsDir: join(home, ".vscode", "extensions"),
      },
      // VS Code Insiders
      {
        packageJson: "/usr/share/code-insiders/resources/app/package.json",
        extensionsDir: join(home, ".vscode-insiders", "extensions"),
      },
      // Cursor
      {
        packageJson: join(home, ".local", "share", "cursor", "resources", "app", "package.json"),
        extensionsDir: join(home, ".cursor", "extensions"),
      },
      {
        packageJson: "/opt/Cursor/resources/app/package.json",
        extensionsDir: join(home, ".cursor", "extensions"),
      },
      // VSCodium
      {
        packageJson: "/usr/share/codium/resources/app/package.json",
        extensionsDir: join(home, ".vscode-oss", "extensions"),
      },
    ];
  }

  if (os === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      // VS Code
      {
        packageJson: join(localAppData, "Programs", "Microsoft VS Code", "resources", "app", "package.json"),
        extensionsDir: join(home, ".vscode", "extensions"),
      },
      // VS Code Insiders
      {
        packageJson: join(localAppData, "Programs", "Microsoft VS Code Insiders", "resources", "app", "package.json"),
        extensionsDir: join(home, ".vscode-insiders", "extensions"),
      },
      // Cursor
      {
        packageJson: join(localAppData, "Programs", "cursor", "resources", "app", "package.json"),
        extensionsDir: join(home, ".cursor", "extensions"),
      },
      // VSCodium
      {
        packageJson: join(localAppData, "Programs", "VSCodium", "resources", "app", "package.json"),
        extensionsDir: join(home, ".vscode-oss", "extensions"),
      },
    ];
  }

  // Unknown platform — return empty
  return [];
}

// ---------------------------------------------------------------------------
// VS Code version detection
// ---------------------------------------------------------------------------

/**
 * Try reading VS Code (or Cursor / Insiders / VSCodium) version
 * from the local installation. Returns the first match found.
 */
export async function detectLocalVSCodeVersion(): Promise<string | null> {
  const candidates = getEditorCandidates();

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate.packageJson, "utf-8");
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Not installed at this path — try next
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Copilot Chat extension version detection
// ---------------------------------------------------------------------------

/**
 * Scan all known extension directories for github.copilot-chat-*,
 * return the highest version found across all editors.
 */
export async function detectLocalCopilotVersion(): Promise<string | null> {
  const candidates = getEditorCandidates();

  // Deduplicate extension dirs (e.g. snap + deb both use ~/.vscode/extensions)
  const extensionsDirs = [...new Set(candidates.map((c) => c.extensionsDir))];

  const glob = new Glob("github.copilot-chat-*/package.json");
  const allVersioned: { dir: string; path: string; version: string }[] = [];

  for (const dir of extensionsDirs) {
    try {
      for await (const path of glob.scan({ cwd: dir })) {
        const match = path.match(/github\.copilot-chat-(\d+\.\d+\.\d+)/);
        if (match) {
          allVersioned.push({ dir, path, version: match[1] });
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  if (allVersioned.length === 0) return null;

  // Sort descending by semver, pick highest
  allVersioned.sort((a, b) => compareSemver(b.version, a.version));

  const best = allVersioned[0];
  try {
    const fullPath = join(best.dir, best.path);
    const raw = await readFile(fullPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

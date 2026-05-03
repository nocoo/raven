import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  mockPlatform: "darwin" as string,
  mockHomedir: "/Users/testuser" as string,
  readFileImpl: (async () => {
    throw new Error("ENOENT");
  }) as (path: string, enc: string) => Promise<string>,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    platform: () => mocks.mockPlatform,
    homedir: () => mocks.mockHomedir,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (path: string, enc: string) => mocks.readFileImpl(path, enc),
  };
});

// Now import the module under test
const { detectLocalVSCodeVersion, detectLocalCopilotVersion } = await import(
  "../../src/services/detect-local-versions.ts"
);

beforeEach(() => {
  mocks.mockPlatform = "darwin";
  mocks.mockHomedir = "/Users/testuser";
  mocks.readFileImpl = async () => {
    throw new Error("ENOENT");
  };
});

// ---------------------------------------------------------------------------
// detectLocalVSCodeVersion
// ---------------------------------------------------------------------------

describe("detectLocalVSCodeVersion", () => {
  test("returns version from first valid package.json on macOS", async () => {
    mocks.mockPlatform = "darwin";
    mocks.readFileImpl = async (path) => {
      if (path.includes("Visual Studio Code.app")) {
        return JSON.stringify({ version: "1.92.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.92.0");
  });

  test("returns version from Cursor when VS Code not installed on macOS", async () => {
    mocks.mockPlatform = "darwin";
    mocks.readFileImpl = async (path) => {
      if (path.includes("Cursor.app")) {
        return JSON.stringify({ version: "0.40.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("0.40.0");
  });

  test("returns null when no editors installed", async () => {
    mocks.mockPlatform = "darwin";
    expect(await detectLocalVSCodeVersion()).toBeNull();
  });

  test("returns null for package.json without version field", async () => {
    mocks.mockPlatform = "darwin";
    mocks.readFileImpl = async (path) => {
      if (path.includes("Visual Studio Code.app")) {
        return JSON.stringify({ name: "code-oss" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBeNull();
  });

  test("handles invalid JSON gracefully", async () => {
    mocks.mockPlatform = "darwin";
    mocks.readFileImpl = async (path) => {
      if (path.includes("Visual Studio Code.app")) {
        return "not-json{{{";
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBeNull();
  });

  // Linux platform branch
  test("returns version from /usr/share/code on linux", async () => {
    mocks.mockPlatform = "linux";
    mocks.mockHomedir = "/home/testuser";
    mocks.readFileImpl = async (path) => {
      if (path === "/usr/share/code/resources/app/package.json") {
        return JSON.stringify({ version: "1.91.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.91.0");
  });

  test("returns version from snap path on linux", async () => {
    mocks.mockPlatform = "linux";
    mocks.mockHomedir = "/home/testuser";
    mocks.readFileImpl = async (path) => {
      if (path.includes("/snap/code/")) {
        return JSON.stringify({ version: "1.91.1" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.91.1");
  });

  test("returns version from Cursor on linux", async () => {
    mocks.mockPlatform = "linux";
    mocks.mockHomedir = "/home/testuser";
    mocks.readFileImpl = async (path) => {
      if (path.includes("/opt/Cursor/")) {
        return JSON.stringify({ version: "0.39.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("0.39.0");
  });

  test("returns version from VSCodium on linux", async () => {
    mocks.mockPlatform = "linux";
    mocks.mockHomedir = "/home/testuser";
    mocks.readFileImpl = async (path) => {
      if (path.includes("/usr/share/codium/")) {
        return JSON.stringify({ version: "1.90.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.90.0");
  });

  // Win32 platform branch
  test("returns version on win32 with LOCALAPPDATA", async () => {
    mocks.mockPlatform = "win32";
    mocks.mockHomedir = "C:\\Users\\testuser";
    process.env.LOCALAPPDATA = "C:\\Users\\testuser\\AppData\\Local";
    mocks.readFileImpl = async (path) => {
      if (path.includes("Microsoft VS Code")) {
        return JSON.stringify({ version: "1.93.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.93.0");
    delete process.env.LOCALAPPDATA;
  });

  test("uses fallback LOCALAPPDATA on win32", async () => {
    mocks.mockPlatform = "win32";
    mocks.mockHomedir = "C:\\Users\\testuser";
    delete process.env.LOCALAPPDATA;
    mocks.readFileImpl = async (path) => {
      if (path.includes("Microsoft VS Code") && !path.includes("Insiders")) {
        return JSON.stringify({ version: "1.93.1" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.93.1");
  });

  test("returns version from Cursor on win32", async () => {
    mocks.mockPlatform = "win32";
    mocks.mockHomedir = "C:\\Users\\testuser";
    process.env.LOCALAPPDATA = "C:\\Users\\testuser\\AppData\\Local";
    mocks.readFileImpl = async (path) => {
      if (path.includes("cursor")) {
        return JSON.stringify({ version: "0.41.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("0.41.0");
    delete process.env.LOCALAPPDATA;
  });

  test("returns version from VSCodium on win32", async () => {
    mocks.mockPlatform = "win32";
    mocks.mockHomedir = "C:\\Users\\testuser";
    process.env.LOCALAPPDATA = "C:\\Users\\testuser\\AppData\\Local";
    mocks.readFileImpl = async (path) => {
      if (path.includes("VSCodium")) {
        return JSON.stringify({ version: "1.89.0" });
      }
      throw new Error("ENOENT");
    };
    expect(await detectLocalVSCodeVersion()).toBe("1.89.0");
    delete process.env.LOCALAPPDATA;
  });

  test("returns null on unknown platform", async () => {
    mocks.mockPlatform = "freebsd";
    expect(await detectLocalVSCodeVersion()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectLocalCopilotVersion
// ---------------------------------------------------------------------------

describe("detectLocalCopilotVersion", () => {
  let tmpDir: string;

  async function setupExtDir(relPath: string, versions: { dir: string; pkg: object }[]) {
    const extDir = join(tmpDir, relPath);
    await mkdir(extDir, { recursive: true });
    for (const v of versions) {
      const d = join(extDir, v.dir);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "package.json"), JSON.stringify(v.pkg));
    }
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dlv-test-"));
    mocks.mockHomedir = tmpDir;
    // For copilot tests, readFile needs to work for real files in tmpDir
    mocks.readFileImpl = async (path, _enc) => {
      const f = Bun.file(path);
      if (!(await f.exists())) throw new Error("ENOENT");
      return await f.text();
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no extensions directories exist", async () => {
    mocks.mockPlatform = "darwin";
    // No extension dirs created — Glob will throw ENOENT
    expect(await detectLocalCopilotVersion()).toBeNull();
  });

  test("returns null on unknown platform (no candidates)", async () => {
    mocks.mockPlatform = "freebsd";
    expect(await detectLocalCopilotVersion()).toBeNull();
  });

  test("returns highest copilot version across extensions", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-0.20.0", pkg: { version: "0.20.0" } },
      { dir: "github.copilot-chat-0.22.0", pkg: { version: "0.22.0" } },
    ]);

    expect(await detectLocalCopilotVersion()).toBe("0.22.0");
  }, 30000);

  test("returns version when only one extension found", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-0.19.0", pkg: { version: "0.19.0" } },
    ]);

    expect(await detectLocalCopilotVersion()).toBe("0.19.0");
  }, 30000);

  test("returns null when best version package.json has no version field", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-0.21.0", pkg: { name: "copilot-chat" } },
    ]);

    expect(await detectLocalCopilotVersion()).toBeNull();
  }, 30000);

  test("picks highest version across multiple extension dirs", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-0.18.0", pkg: { version: "0.18.0" } },
    ]);
    await setupExtDir(".cursor/extensions", [
      { dir: "github.copilot-chat-0.23.0", pkg: { version: "0.23.0" } },
    ]);

    expect(await detectLocalCopilotVersion()).toBe("0.23.0");
  });

  test("ignores entries that don't match version pattern", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-nightly", pkg: { version: "0.0.1" } },
    ]);

    expect(await detectLocalCopilotVersion()).toBeNull();
  });

  test("returns null when best package.json read throws after glob match", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-0.30.0", pkg: { version: "0.30.0" } },
    ]);
    // Make the *final* read throw after glob has discovered the file.
    mocks.readFileImpl = async (path) => {
      if (path.includes("github.copilot-chat-0.30.0")) {
        throw new Error("EACCES");
      }
      const f = Bun.file(path);
      if (!(await f.exists())) throw new Error("ENOENT");
      return await f.text();
    };
    expect(await detectLocalCopilotVersion()).toBeNull();
  });

  test("compareSemver returns 0 for identical versions (sort stays stable)", async () => {
    mocks.mockPlatform = "darwin";
    await setupExtDir(".vscode/extensions", [
      { dir: "github.copilot-chat-0.40.0", pkg: { version: "0.40.0" } },
    ]);
    await setupExtDir(".cursor/extensions", [
      { dir: "github.copilot-chat-0.40.0", pkg: { version: "0.40.0" } },
    ]);
    // Both candidates compare equal — exercises the `return 0` branch.
    expect(await detectLocalCopilotVersion()).toBe("0.40.0");
  });
});

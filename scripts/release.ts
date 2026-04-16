#!/usr/bin/env bun
/**
 * Automated release script for raven monorepo.
 *
 * Bumps version across all package.json files, syncs lockfile,
 * generates CHANGELOG entries from conventional commits,
 * commits, tags, pushes, and creates a GitHub release.
 *
 * Usage:
 *   bun run release              # patch bump (default)
 *   bun run release -- minor     # minor bump
 *   bun run release -- major     # major bump
 *   bun run release -- 2.0.0     # explicit version
 *   bun run release -- --dry-run # preview without side effects
 *
 * Env:
 *   Requires `gh` CLI authenticated for GitHub release creation.
 *
 * Adapted from pew/scripts/release.ts for raven monorepo.
 */

import { spawn } from "child_process";
import { resolve as pathResolve } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = pathResolve(import.meta.dirname as string, "..");
const PACKAGE_JSON = pathResolve(PROJECT_ROOT, "package.json");
const CHANGELOG_MD = pathResolve(PROJECT_ROOT, "CHANGELOG.md");

// ---------------------------------------------------------------------------
// Monorepo version targets
// ---------------------------------------------------------------------------

interface VersionTarget {
  /** Relative path from monorepo root */
  path: string;
  /** How to find and replace the version string */
  pattern: "json-version";
}

const VERSION_TARGETS: VersionTarget[] = [
  { path: "package.json", pattern: "json-version" },
  { path: "packages/dashboard/package.json", pattern: "json-version" },
  { path: "packages/proxy/package.json", pattern: "json-version" },
];

const BUMP_TYPES = ["patch", "minor", "major"] as const;
type BumpType = (typeof BUMP_TYPES)[number];

interface Commit {
  hash: string;
  subject: string;
}

interface ChangelogSections {
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
}

const COMMIT_TYPE_MAP: Record<string, keyof ChangelogSections> = {
  feat: "added",
  fix: "fixed",
  refactor: "changed",
  chore: "changed",
  docs: "changed",
  test: "changed",
  perf: "changed",
  style: "changed",
  ci: "changed",
  build: "changed",
};

const REMOVED_KEYWORDS = /\b(remove|delete|drop)\b/i;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CONVENTIONAL_RE = /^(\w+)(?:\(.+?\))?!?:\s*(.+)$/;

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; inherit?: boolean },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      stdio: opts?.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (!opts?.inherit) {
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
    }

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runOrDie(
  cmd: string,
  args: string[],
  errorMsg: string,
): Promise<string> {
  const result = await run(cmd, args);
  if (result.code !== 0) {
    console.error(`❌ ${errorMsg}`);
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    process.exit(1);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseSemver(version: string): [number, number, number] {
  if (!SEMVER_RE.test(version)) {
    console.error(`❌ Invalid semver: "${version}"`);
    process.exit(1);
  }
  return version.split(".").map(Number) as [number, number, number];
}

function compareSemver(a: string, b: string): number {
  const [a0, a1, a2] = parseSemver(a);
  const [b0, b1, b2] = parseSemver(b);
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  return a2 - b2;
}

function bumpVersion(current: string, bumpArg: string): string {
  if (SEMVER_RE.test(bumpArg)) {
    if (compareSemver(bumpArg, current) <= 0) {
      console.error(
        `❌ Explicit version ${bumpArg} must be greater than current ${current}`,
      );
      process.exit(1);
    }
    return bumpArg;
  }

  if (!BUMP_TYPES.includes(bumpArg as BumpType)) {
    console.error(`❌ Invalid bump type: "${bumpArg}"`);
    console.error("   Use: patch | minor | major | x.y.z");
    process.exit(1);
  }

  const [major, minor, patch] = parseSemver(current);
  switch (bumpArg as BumpType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

// ---------------------------------------------------------------------------
// Monorepo version update
// ---------------------------------------------------------------------------

function readCurrentVersion(): string {
  const raw = readFileSync(PACKAGE_JSON, "utf-8");
  const pkg = JSON.parse(raw);
  return pkg.version;
}

function updateVersionInFile(
  target: VersionTarget,
  oldVersion: string,
  newVersion: string,
): boolean {
  const abs = pathResolve(PROJECT_ROOT, target.path);

  // Skip if file has no version field (e.g. proxy has "version": null)
  const content = readFileSync(abs, "utf-8");
  const pkg = JSON.parse(content);
  if (pkg.version === null || pkg.version === undefined) {
    // Set the version for the first time
    const updated = content.replace(
      /"version":\s*null/,
      `"version": "${newVersion}"`,
    );
    if (updated !== content) {
      writeFileSync(abs, updated, "utf-8");
      console.log(`  ✓ ${target.path} (null → ${newVersion})`);
      return true;
    }
    console.log(`  ⊘ ${target.path} — no version field, skipping`);
    return true;
  }

  const pattern = `"version": "${oldVersion}"`;
  const replacement = `"version": "${newVersion}"`;
  if (!content.includes(pattern)) {
    // Workspace package may have a different version — set it to newVersion
    const currentPkgVersion = pkg.version;
    const altPattern = `"version": "${currentPkgVersion}"`;
    if (content.includes(altPattern)) {
      const updated = content.replace(altPattern, replacement);
      writeFileSync(abs, updated, "utf-8");
      console.log(`  ✓ ${target.path} (${currentPkgVersion} → ${newVersion})`);
      return true;
    }
    console.error(`  ✗ ${target.path} — version pattern not found`);
    return false;
  }

  const updated = content.replace(pattern, replacement);
  writeFileSync(abs, updated, "utf-8");
  console.log(`  ✓ ${target.path}`);
  return true;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function getLastTag(): Promise<string | undefined> {
  const result = await run("git", ["describe", "--tags", "--abbrev=0"]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim();
}

async function getCommitsSinceTag(
  tag: string | undefined,
): Promise<Commit[]> {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const args = ["log", range, "--format=%H|||%s"];
  const stdout = await runOrDie("git", args, "Failed to read git log");

  if (!stdout) return [];

  return stdout
    .split("\n")
    .filter((line) => line.includes("|||"))
    .map((line) => {
      const sepIdx = line.indexOf("|||");
      return {
        hash: line.slice(0, sepIdx),
        subject: line.slice(sepIdx + 3),
      };
    })
    .filter((c) => !c.subject.startsWith("release: v"));
}

// ---------------------------------------------------------------------------
// CHANGELOG helpers
// ---------------------------------------------------------------------------

function classifyCommits(commits: Commit[]): ChangelogSections {
  const sections: ChangelogSections = {
    added: [],
    changed: [],
    fixed: [],
    removed: [],
  };

  for (const commit of commits) {
    const { subject } = commit;

    // Skip merge commits
    if (subject.startsWith("Merge ")) continue;

    let description: string;
    let section: keyof ChangelogSections;

    const match = CONVENTIONAL_RE.exec(subject);
    if (match) {
      const type = (match[1] as string).toLowerCase();
      description = capitalizeFirst((match[2] as string).trim());
      section = COMMIT_TYPE_MAP[type] ?? "changed";
    } else {
      description = capitalizeFirst(subject.trim());
      section = "changed";
    }

    // Override: keywords indicating removal
    if (REMOVED_KEYWORDS.test(subject) && section === "changed") {
      section = "removed";
    }

    if (!sections[section].includes(description)) {
      sections[section].push(description);
    }
  }

  return sections;
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatChangelogSection(
  version: string,
  sections: ChangelogSections,
): string {
  const lines: string[] = [`## v${version}`];

  const sectionOrder: [keyof ChangelogSections, string][] = [
    ["added", "Added"],
    ["changed", "Changed"],
    ["fixed", "Fixed"],
    ["removed", "Removed"],
  ];

  for (const [key, heading] of sectionOrder) {
    const items = sections[key];
    if (items.length > 0) {
      lines.push("");
      lines.push(`### ${heading}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    }
  }

  return lines.join("\n");
}

function updateChangelog(newSection: string): void {
  if (!existsSync(CHANGELOG_MD)) {
    writeFileSync(
      CHANGELOG_MD,
      `# Changelog\n\n${newSection}\n`,
      "utf-8",
    );
    return;
  }

  const content = readFileSync(CHANGELOG_MD, "utf-8");
  const marker = "## v";
  const idx = content.indexOf(marker);

  let updated: string;
  if (idx === -1) {
    updated = content.trimEnd() + "\n\n" + newSection + "\n";
  } else {
    updated = content.slice(0, idx) + newSection + "\n\n" + content.slice(idx);
  }

  writeFileSync(CHANGELOG_MD, updated);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- Parse args ---
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
  const isDryRun = rawArgs.includes("--dry-run");
  const bumpArg = rawArgs.find((a) => a !== "--dry-run") ?? "patch";

  if (isDryRun) {
    console.log("🏜️  Dry-run mode — no changes will be made\n");
  }

  // --- Phase 0: Preflight ---
  console.log("📋 Preflight checks...\n");

  // Clean working tree
  const status = await runOrDie(
    "git",
    ["status", "--porcelain"],
    "Failed to check git status",
  );
  if (status) {
    console.error(
      "❌ Working tree is not clean. Commit or stash changes first.",
    );
    console.error(status);
    process.exit(1);
  }

  // On a branch
  const branch = await runOrDie(
    "git",
    ["symbolic-ref", "--short", "HEAD"],
    "Detached HEAD — checkout a branch first",
  );

  // gh auth
  const ghResult = await run("gh", ["auth", "status"]);
  const ghAuthed = ghResult.code === 0;
  if (!ghAuthed) {
    console.log("⚠️  gh CLI not authenticated — will skip GitHub release");
  }

  // Current version & bump
  const currentVersion = readCurrentVersion();
  const newVersion = bumpVersion(currentVersion, bumpArg);
  const lastTag = await getLastTag();

  console.log("📦 raven release");
  console.log(`   Current version: ${currentVersion}`);
  console.log(`   New version:     ${newVersion}`);
  console.log(`   Bump type:       ${bumpArg}`);
  console.log(`   Branch:          ${branch}`);
  console.log(`   Last tag:        ${lastTag ?? "(none)"}`);
  console.log(`   Targets:         ${VERSION_TARGETS.length} files`);
  console.log("");

  // --- Phase 1: Version bump across monorepo ---
  console.log(
    `📝 Phase 1: Updating version in ${VERSION_TARGETS.length} files...\n`,
  );

  if (isDryRun) {
    console.log(
      `   [dry-run] Would update ${VERSION_TARGETS.length} files: ${currentVersion} → ${newVersion}`,
    );
    for (const t of VERSION_TARGETS) {
      console.log(`     • ${t.path}`);
    }
    console.log("   [dry-run] Would run bun install to sync lockfile");
  } else {
    let failures = 0;
    for (const target of VERSION_TARGETS) {
      const ok = updateVersionInFile(target, currentVersion, newVersion);
      if (!ok) failures++;
    }

    if (failures > 0) {
      console.error(
        `\n❌ Failed to update ${failures}/${VERSION_TARGETS.length} files. Aborting.`,
      );
      console.error("   Run `git checkout .` to revert partial changes.");
      process.exit(1);
    }

    console.log(
      `\n   ✅ All ${VERSION_TARGETS.length} files updated: ${currentVersion} → ${newVersion}`,
    );

    console.log("   🔄 Running bun install to sync lockfile...");
    const installResult = await run("bun", ["install"], { inherit: true });
    if (installResult.code !== 0) {
      console.error("❌ bun install failed");
      process.exit(1);
    }
    console.log("   ✅ Lockfile synced");
  }
  console.log("");

  // --- Phase 2: CHANGELOG ---
  console.log("📝 Phase 2: Generating CHANGELOG...\n");

  const commits = await getCommitsSinceTag(lastTag);
  if (commits.length === 0) {
    console.log(
      "   ⚠️  No commits since last tag — CHANGELOG section will be empty",
    );
  }

  const sections = classifyCommits(commits);
  const changelogSection = formatChangelogSection(newVersion, sections);

  console.log("   --- Generated CHANGELOG section ---");
  console.log(changelogSection);
  console.log("   --- End ---\n");

  if (isDryRun) {
    console.log(
      "   [dry-run] Would prepend above section to CHANGELOG.md",
    );
  } else {
    updateChangelog(changelogSection);
    console.log("   ✅ CHANGELOG.md updated");
  }
  console.log("");

  // --- Phase 3: Commit ---
  console.log("💾 Phase 3: Committing...\n");

  const filesToStage = [
    ...VERSION_TARGETS.map((t) => t.path),
    "bun.lock",
    "CHANGELOG.md",
  ];

  if (isDryRun) {
    console.log(
      `   [dry-run] Would commit: release: v${newVersion}`,
    );
    console.log(`   [dry-run] Files: ${filesToStage.join(", ")}`);
  } else {
    await runOrDie("git", ["add", ...filesToStage], "Failed to stage files");
    const commitResult = await run("git", [
      "commit",
      "-m",
      `release: v${newVersion}`,
    ]);
    if (commitResult.code !== 0) {
      console.error("❌ Commit failed (pre-commit hooks?)");
      if (commitResult.stderr.trim()) {
        console.error(commitResult.stderr.trim());
      }
      console.error("   Fix the issues and retry.");
      process.exit(1);
    }
    console.log(`   ✅ Committed: release: v${newVersion}`);
  }
  console.log("");

  // --- Phase 4: Push + Tag + Release ---
  console.log("🚀 Phase 4: Push, tag & release\n");

  console.log("   The following actions will be performed:");
  console.log("     • git push");
  console.log(`     • git tag -a v${newVersion} -m "v${newVersion}"`);
  console.log("     • git push --tags");
  if (ghAuthed) {
    console.log(
      `     • gh release create v${newVersion} --title "v${newVersion}"`,
    );
  }
  console.log("");

  if (isDryRun) {
    console.log("   [dry-run] Would perform the above actions");
    console.log(`\n✅ Dry run complete for v${newVersion}`);
    process.exit(0);
  }

  // Push
  console.log("\n   🔄 Pushing...");
  const pushResult = await run("git", ["push"], { inherit: true });
  if (pushResult.code !== 0) {
    console.error("❌ git push failed");
    console.error("   Recovery commands:");
    console.error("     git push");
    console.error(`     git tag -a v${newVersion} -m "v${newVersion}"`);
    console.error("     git push --tags");
    console.error(
      `     gh release create v${newVersion} --title "v${newVersion}" --notes "..."`,
    );
    process.exit(1);
  }
  console.log("   ✅ Pushed");

  // Tag
  console.log(`   🔄 Creating tag v${newVersion}...`);
  const tagResult = await run("git", [
    "tag",
    "-a",
    `v${newVersion}`,
    "-m",
    `v${newVersion}`,
  ]);
  if (tagResult.code !== 0) {
    console.error(`❌ Failed to create tag v${newVersion}`);
    if (tagResult.stderr.includes("already exists")) {
      console.error(
        `   Tag already exists. Delete with: git tag -d v${newVersion}`,
      );
    }
    process.exit(1);
  }

  // Push tags
  console.log("   🔄 Pushing tags...");
  const pushTagResult = await run("git", ["push", "--tags"], {
    inherit: true,
  });
  if (pushTagResult.code !== 0) {
    console.error("❌ git push --tags failed");
    console.error("   Recovery: git push --tags");
    process.exit(1);
  }
  console.log(`   ✅ Tag v${newVersion} pushed`);

  // GitHub Release
  if (ghAuthed) {
    console.log(`   🔄 Creating GitHub release v${newVersion}...`);
    const releaseResult = await run("gh", [
      "release",
      "create",
      `v${newVersion}`,
      "--title",
      `v${newVersion}`,
      "--notes",
      changelogSection,
    ]);

    if (releaseResult.code !== 0) {
      console.error("⚠️  GitHub release creation failed (tag is pushed)");
      console.error(
        `   Create manually: gh release create v${newVersion} --title "v${newVersion}"`,
      );
    } else {
      const releaseUrl = releaseResult.stdout.trim();
      console.log("   ✅ GitHub release created");
      if (releaseUrl) {
        console.log(`   🔗 ${releaseUrl}`);
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log(`✅ Released v${newVersion}`);
  console.log(`   📋 Commit:  release: v${newVersion}`);
  console.log(`   🏷️  Tag:     v${newVersion}`);
  console.log(`   📦 Files:   ${VERSION_TARGETS.length} updated`);
  if (ghAuthed) {
    const repoUrl = await run("gh", [
      "repo",
      "view",
      "--json",
      "url",
      "-q",
      ".url",
    ]);
    const repo = repoUrl.stdout.trim();
    if (repo) {
      console.log(
        `   🔗 Release: ${repo}/releases/tag/v${newVersion}`,
      );
    }
  }
  console.log("=".repeat(50));
}

main().catch((err: unknown) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});

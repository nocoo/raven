/**
 * Coverage threshold runner for bun:test (proxy package).
 *
 * Runs `bun test --coverage` with lcov reporter, parses lcov.info
 * for line coverage, and exits non-zero if below threshold.
 *
 * Usage:  bun run scripts/check-coverage.ts [threshold]
 *
 * Default threshold: 90%
 */

const THRESHOLD = Number(process.argv[2]) || 90;
const COV_DIR = `${import.meta.dir}/../packages/proxy/coverage`;

const proc = Bun.spawn(
  [
    "bun",
    "test",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${COV_DIR}`,
    "test/db",
    "test/lib",
    "test/routes",
    "test/services",
    "test/translate",
    "test/util",
    "test/ws",
    "test/middleware.test.ts",
    "test/app.test.ts",
    "test/config.test.ts",
  ],
  {
    cwd: `${import.meta.dir}/../packages/proxy`,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await proc.exited;

if (exitCode !== 0) {
  process.exit(exitCode);
}

// Parse lcov.info for total line coverage
const lcovPath = `${COV_DIR}/lcov.info`;
const lcovFile = Bun.file(lcovPath);

if (!(await lcovFile.exists())) {
  console.error("\n❌ lcov.info not generated — cannot check coverage");
  process.exit(1);
}

const lcov = await lcovFile.text();
let linesFound = 0;
let linesHit = 0;

for (const line of lcov.split("\n")) {
  if (line.startsWith("LF:")) linesFound += parseInt(line.slice(3), 10);
  if (line.startsWith("LH:")) linesHit += parseInt(line.slice(3), 10);
}

const coverage = linesFound > 0 ? (linesHit / linesFound) * 100 : 0;

console.log(
  `\n📊 Proxy coverage: ${coverage.toFixed(1)}% lines (threshold: ${THRESHOLD}%)`,
);

if (coverage < THRESHOLD) {
  console.error(
    `❌ Line coverage ${coverage.toFixed(1)}% is below threshold ${THRESHOLD}%`,
  );
  process.exit(1);
}

console.log("✅ Coverage threshold passed");

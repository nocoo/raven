import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { getConfigDir, getDataDir, getDefaultDbPath } from "../packages/proxy/src/lib/app-dirs"
import { selectLiveCases } from "./lib/live-proxy-cases"
import { livePreflight, liveProxyUrl, readLiveKey, runLiveCases, type LiveResult } from "./lib/live-proxy-runner"

const { values } = parseArgs({
  args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: {
    execute: { type: "boolean", default: false },
    preflight: { type: "boolean", default: false },
    case: { type: "string", multiple: true, default: [] },
    url: { type: "string", default: "http://127.0.0.1:7024" },
    db: { type: "string", default: getDefaultDbPath() },
    "key-file": { type: "string", default: join(getConfigDir(), "live-tests", "key") },
  },
})

let liveKey: string | undefined
try {
  const cases = selectLiveCases(values.case)
  const url = liveProxyUrl(values.url)
  console.log(`真实 Proxy 验收：${cases.length} 个用例，${values.execute ? "执行" : values.preflight ? "仅预检" : "仅计划"}`)
  console.table(cases.map((item) => ({ case: item.id, path: item.path, strategy: item.strategy, model: item.resolvedModel })))
  if (values.execute || values.preflight) {
    const key = readLiveKey(values["key-file"])
    liveKey = key
    const db = new Database(values.db, { readonly: true, strict: true })
    try {
      const preflight = livePreflight(db, key, cases)
      const response = await fetch(`${url}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      })
      assert.equal(response.status, 200, "Authenticated cache-only /v1/models preflight failed")
      const catalog = await response.json() as { data: { id: string }[] }
      const ids = catalog.data.map((model) => model.id)
      assert.equal(ids.length, new Set(ids).size, "/v1/models contains duplicate model IDs")
      for (const model of new Set(["auto", ...cases.map((item) => item.resolvedModel)])) assert.ok(ids.includes(model), `Served model cache lacks ${model}`)
      console.log(`预检通过：key=${preflight.key.name}，rule=${preflight.rule.name}；未刷新模型目录。`)
      if (values.execute) {
        const root = join(getDataDir(), "live-tests", "runs")
        mkdirSync(root, { recursive: true, mode: 0o700 })
        const artifacts = mkdtempSync(join(root, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-`))
        chmodSync(artifacts, 0o700)
        const reportPath = join(artifacts, "report.json")
        const runId = crypto.randomUUID()
        const report = {
          version: 1, run_id: runId, started_at: new Date().toISOString(), finished_at: null as string | null, proxy_url: url,
          git_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          working_tree_dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
          runtime: { bun: Bun.version, node: process.version },
          preflight, cases,
          coverage_gaps: [
            ...(!cases.some((item) => item.upstreamFormat === "anthropic") ? ["No Anthropic-native model in this selected matrix"] : []),
            "Chat/Responses to Messages conversion is not selected by the current dual-protocol Claude catalog",
            "No custom upstream; no quota exhaustion, schedule switching, server tools, image/audio or load cases",
          ],
          results: [] as readonly LiveResult[],
        }
        let lastPrinted = ""
        const results = await runLiveCases({
          cases, url, key, keyId: preflight.key.id, db, runId,
          checkpoint(results) {
            report.results = results
            if (results.some((item) => item.status === "failed") || results.every((item) => item.status === "passed")) report.finished_at = new Date().toISOString()
            writeFileSync(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2).replaceAll(key, "[REDACTED]")}\n`, { mode: 0o600 })
            renameSync(`${reportPath}.tmp`, reportPath)
            const finished = results.filter((item) => item.status === "passed" || item.status === "failed").at(-1)
            if (finished && lastPrinted !== finished.case_id) {
              lastPrinted = finished.case_id
              console.log(`${finished.status === "passed" ? "通过" : "失败"} ${finished.case_id}：${finished.duration_ms}ms，上游尝试 ${finished.telemetry?.attempts.length ?? 0} 次`)
              if (finished.errors.length) console.error(finished.errors.join("\n").replaceAll(key, "[REDACTED]"))
            }
          },
        })
        console.log(`报告：${reportPath}`)
        console.log(`通过 ${results.filter((item) => item.status === "passed").length}；失败 ${results.filter((item) => item.status === "failed").length}；未运行 ${results.filter((item) => item.status === "not_run").length}`)
        if (results.some((item) => item.status !== "passed")) process.exitCode = 1
      }
    } finally {
      db.close()
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(liveKey ? message.replaceAll(liveKey, "[REDACTED]") : message)
  process.exitCode = 1
}

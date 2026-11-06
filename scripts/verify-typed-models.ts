import assert from "node:assert/strict"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { getConfigDir } from "../packages/proxy/src/lib/app-dirs"
import { liveProxyUrl, parseLiveKey, readLiveKey } from "./lib/live-proxy-runner"
import { runTypedModelCases, selectTypedModelCases } from "./typed-model-cases"

const { values } = parseArgs({
  args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: {
    execute: { type: "boolean", default: false },
    case: { type: "string", multiple: true, default: [] },
    url: { type: "string", default: "http://127.0.0.1:7024" },
    "key-file": { type: "string" },
    "key-stdin": { type: "boolean", default: false },
  },
})

let liveKey: string | undefined
try {
  const cases = selectTypedModelCases(values.case)
  const url = liveProxyUrl(values.url)
  console.log(`Typed-model 验收：${cases.length} 个用例，${values.execute ? "执行" : "仅计划"}`)
  console.table(cases.map((item) => ({ case: item.id, type: item.kind, declared: item.declaredPath ?? "none", path: item.path })))
  if (values.execute) {
    assert.ok(!(values["key-stdin"] && values["key-file"]), "Choose either --key-stdin or --key-file")
    const key = values["key-stdin"] ? parseLiveKey(await Bun.stdin.text()) : readLiveKey(values["key-file"] ?? join(getConfigDir(), "live-tests", "key"))
    liveKey = key
    const results = await runTypedModelCases(cases, { url, key, fetchImpl: fetch }, (result) => {
      if (result.error === "not_run") return
      console.log(`${result.error ? "失败" : "通过"} ${result.id}：HTTP ${result.status}，${result.durationMs}ms${result.error ? ` — ${result.error}` : ""}`)
      if (result.error) {
        console.log(`  响应片段：${result.excerpt.slice(0, 400)}`)
        console.error("检测到错误，停止后续 case；未运行的 case 不做探测。")
      }
    })
    console.log(`通过 ${results.filter((item) => item.error === null).length}；失败 ${results.filter((item) => item.error !== null && item.error !== "not_run").length}；未运行 ${results.filter((item) => item.error === "not_run").length}`)
    if (results.some((item) => item.error !== null)) process.exitCode = 1
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(liveKey ? message.replaceAll(liveKey, "[REDACTED]") : message)
  process.exitCode = 1
}

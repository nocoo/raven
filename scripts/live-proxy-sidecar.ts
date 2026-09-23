import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { createApp } from "../packages/proxy/src/app"
import { loadConfig } from "../packages/proxy/src/config"
import { restoreCopilotCatalog } from "../packages/proxy/src/composition/catalog"
import { startRequestSink } from "../packages/proxy/src/db/request-sink"
import { copilotBaseUrl } from "../packages/proxy/src/lib/api-config"
import { startBridge, stopBridge } from "../packages/proxy/src/lib/socks5-bridge"
import { state } from "../packages/proxy/src/lib/state"
import { getConfigDir } from "../packages/proxy/src/lib/app-dirs"
import { cacheOptimizations, cacheServerTools, cacheIPWhitelist, cacheCorsSettings, cacheSocks5Settings } from "../packages/proxy/src/lib/utils"
import type { SettingsSnapshot } from "../packages/proxy/src/routes/settings"
import { getCopilotToken } from "../packages/proxy/src/services/github/get-copilot-token"
import { disableTerminalSink } from "../packages/proxy/src/util/logger"
import { liveRequestGuard } from "./lib/live-proxy-guard"
import { liveCases } from "./lib/live-proxy-cases"
import { livePreflight, openLiveDatabase, parseLiveKey, readLiveKey } from "./lib/live-proxy-runner"

const { values } = parseArgs({ args: process.argv.slice(2), options: { execute: { type: "boolean", default: false }, limit: { type: "string", default: "66" }, "key-stdin": { type: "boolean", default: false }, "key-file": { type: "string" } } })
let phase = "本地准备"
if (!values.execute) {
  console.log("仅计划：--execute 加载现有配置、Key 和路由，获取一次 Copilot 凭证，并启动禁止重放的临时本地 Proxy。")
} else {
  try {
    await run()
  } catch {
    console.error(`诊断 Proxy 在${phase}阶段失败；未重试。请检查已有配置、凭证和日常 Proxy。`)
    process.exitCode = 1
  }
}

async function run() {
  const config = loadConfig()
  assert.ok(!(values["key-stdin"] && values["key-file"]), "Choose either --key-stdin or --key-file")
  const key = values["key-stdin"] ? parseLiveKey(await Bun.stdin.text()) : readLiveKey(values["key-file"] ?? join(getConfigDir(), "live-tests", "key"))
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "Commit the tested revision before starting live diagnostics")
  const guard = liveRequestGuard(fetch, copilotBaseUrl(state), Number(values.limit))
  const db = openLiveDatabase(config.dbPath)
  let stopSink: (() => void) | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  const originalFetch = globalThis.fetch
  try {
    disableTerminalSink()
    livePreflight(db, key, liveCases)
    phase = "日常版本读取"
    console.log("读取日常 Proxy 版本：预算请求 1。")
    const response = await originalFetch(`http://127.0.0.1:${config.port}/api/settings`, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200, "Cannot read effective version headers from the daily Proxy")
    const settings = await response.json() as SettingsSnapshot
    assert.match(settings.vscode_version.effective, /^\d+\.\d+\.\d+/)
    assert.match(settings.copilot_chat_version.effective, /^\d+\.\d+\.\d+/)
    state.vsCodeVersion = settings.vscode_version.effective
    state.copilotChatVersion = settings.copilot_chat_version.effective
    cacheOptimizations(db)
    cacheServerTools(db)
    cacheIPWhitelist(db)
    cacheCorsSettings(db)
    cacheSocks5Settings(db)
    restoreCopilotCatalog(db)
    if (state.socks5Enabled) {
      assert.ok(state.socks5Host && state.socks5Port, "Invalid existing SOCKS5 settings")
      state.socks5BridgePort = await startBridge({ host: state.socks5Host, port: state.socks5Port, ...(state.socks5Username ? { userId: state.socks5Username } : {}), ...(state.socks5Password ? { password: state.socks5Password } : {}) })
    }
    state.githubToken = readFileSync(config.tokenPath, "utf8").trim()
    assert.ok(state.githubToken, "Existing GitHub credential is empty; no device flow will be started")
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => originalFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }), { preconnect: originalFetch.preconnect }) as typeof fetch
    phase = "Copilot 凭证获取"
    console.log("获取 Copilot 凭证：预算请求 2。")
    state.copilotToken = (await getCopilotToken()).token
    assert.ok(state.copilotToken, "Empty Copilot credential")
    phase = "受限代理运行"
    globalThis.fetch = guard.fetch
    stopSink = startRequestSink(db)
    const app = createApp({ db, apiKey: config.apiKey || null, internalKey: config.internalKey || crypto.randomUUID(), githubToken: state.githubToken })
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: (request, runtime) => guard.run(async () => {
      const response = await app.fetch(request, runtime)
      response.headers.set("x-raven-live-revision", revision)
      response.headers.set("x-raven-live-no-replay", "1")
      return response
    }) })
    console.log(`诊断 Proxy：${server.url.origin}；版本 ${revision}；模型请求上限 ${values.limit}；已读取日常版本 1 次、获取凭证 1 次。`)
    await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve) })
    console.log(`诊断结束：实际模型发送 ${guard.count()} 次。`)
  } finally {
    server?.stop(true)
    stopSink?.()
    await stopBridge()
    db.close()
    globalThis.fetch = originalFetch
  }
}

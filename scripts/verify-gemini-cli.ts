import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { COPILOT_UPSTREAM_ID } from "../packages/proxy/src/core/routing-types"
import { state } from "../packages/proxy/src/lib/state"
import type { ChatCompletionsPayload } from "../packages/proxy/src/upstream/copilot-openai"
import { chatResponse, generationEvents, routingHarness, sseResponse } from "../packages/proxy/test/helpers/routing"

const binary = process.argv[2] ?? Bun.which("gemini")
assert.ok(binary, "Install official @google/gemini-cli or supply its executable path")
const artifacts = mkdtempSync(join(tmpdir(), "raven-gemini-cli-"))
chmodSync(artifacts, 0o700)
const runtime = join(artifacts, "state")
const cliHome = join(runtime, "home")
const workspace = join(runtime, "workspace")
mkdirSync(join(cliHome, ".gemini"), { recursive: true, mode: 0o700 })
mkdirSync(workspace, { recursive: true, mode: 0o700 })
writeFileSync(join(workspace, "fixture.txt"), "TOOL_FIXTURE_CONTENT\n")
const h = routingHarness()
Object.assign(state, { githubToken: "fixture-github", copilotToken: "fixture-copilot", socks5Enabled: false, ipWhitelistEnabled: false, rateLimitSeconds: null })
const model = "gemini-3.8-flash"
const hits: ChatCompletionsPayload[] = []
const requests: { path: string; body: unknown }[] = []
const fixtureErrors: string[] = []
let phase: "text" | "tool" | "blocked-tool" = "text"
const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions")
    assert.equal(request.headers.get("authorization"), "Bearer fixture-secret")
    const payload = await request.json() as ChatCompletionsPayload
    hits.push(payload)
    assert.equal(payload.model, model)
    assert.equal(payload.stream, true)
    assert.equal("topK" in payload, false)
    if (phase === "text") return sseResponse(generationEvents("openai", model).map(event => typeof event === "object" ? JSON.parse(JSON.stringify(event).replaceAll("pong", "TEXT_FIXTURE_OK")) : event))
    if (phase === "blocked-tool") return sseResponse([
      { id: "fixture", model, choices: [{ index: 0, delta: { role: "assistant", content: "TOOL_BLOCKED", tool_calls: [{ index: 0, id: "blocked", type: "function", function: { name: "read_file", arguments: '{"file_path":"fixture.txt"}' } }] }, finish_reason: "length" }], usage: chatResponse().usage }, "[DONE]",
    ])
    const result = payload.messages.find(message => message.role === "tool")
    if (result) {
      assert.equal(result.tool_call_id, "call_fixture")
      assert.match(JSON.stringify(result.content), /TOOL_FIXTURE_CONTENT/)
      return sseResponse(generationEvents("openai", model).map(event => typeof event === "object" ? JSON.parse(JSON.stringify(event).replaceAll("pong", "TOOL_FIXTURE_OK")) : event))
    }
    assert.ok(payload.tools?.some(tool => tool.function.name === "read_file"))
    return sseResponse([
      { id: "fixture", model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "read_file", arguments: '{"file_path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"fixture.txt","start_line":1,"end_line":1}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: chatResponse().usage }, "[DONE]",
    ])
  },
  error(error) { fixtureErrors.push(error.message); return new Response("Fixture assertion failed", { status: 500 }) },
})
const provider = h.upstream({ base_url: `${receiver.url.origin}/v1`, manual_models: [model] })
h.bind(provider.id, model)
h.copilot([{ id: model, supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", tokenizer: "o200k_base" } }])
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    if (request.method === "POST") requests.push({ path: new URL(request.url).pathname, body: await request.clone().json() })
    return h.app.fetch(request, { remoteAddress: server.requestIP(request)?.address ?? null })
  },
})
const originalFetch = globalThis.fetch
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok([receiver.url.origin, proxy.url.origin].includes(url.origin), `External request blocked: ${url.origin}`)
  return originalFetch(input, init)
}) as typeof fetch

const settings = {
  security: { auth: { selectedType: "gemini-api-key" }, folderTrust: { enabled: false } },
  advanced: { autoConfigureMemory: false }, general: { enableAutoUpdate: false },
  model: { name: model, maxSessionTurns: 3 }, experimental: { dynamicModelConfiguration: true },
  modelConfigs: {
    modelDefinitions: { [model]: { displayName: model, tier: "flash", family: "gemini-3", isVisible: true, features: { thinking: true } } },
    modelIdResolutions: { [model]: { default: model, contexts: [] } },
    customOverrides: [{ match: { model }, modelConfig: { generateContentConfig: { topK: null } } }],
  },
}
writeFileSync(join(cliHome, ".gemini", "settings.json"), JSON.stringify(settings), { mode: 0o600 })
const guard = join(runtime, "network-guard.mjs")
writeFileSync(guard, `
import net from 'node:net';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const host = typeof options === 'object' ? options.host : args[1];
  const port = typeof options === 'object' ? options.port : options;
  if (host !== '127.0.0.1' || Number(port) !== ${proxy.port}) throw new Error('Fixture blocked external socket');
  return connect.apply(this, args);
};
`)
const env = {
  PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "dumb", TMPDIR: runtime,
  GEMINI_CLI_HOME: cliHome, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(runtime, "system.json"),
  GEMINI_API_KEY: "fixture-client", GOOGLE_GEMINI_BASE_URL: proxy.url.origin,
  GEMINI_CLI_NO_RELAUNCH: "1", NO_COLOR: "1", CI: "1", NO_UPDATE_NOTIFIER: "1",
  NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
}

async function run(name: string, args: string[]) {
  const child = Bun.spawn([binary!, ...args], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 45000)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    writeFileSync(join(artifacts, `${name}.stdout`), stdout)
    writeFileSync(join(artifacts, `${name}.stderr`), stderr)
    assert.equal(code, 0, `${name} failed; see ${artifacts}`)
    return stdout
  } finally { clearTimeout(timer) }
}

try {
  const version = (await run("version", ["--version"])).trim()
  const models = await fetch(`${proxy.url.origin}/v1beta/models`, { headers: { "x-goog-api-key": "fixture-client" } })
  assert.equal(models.status, 200)
  h.bind(COPILOT_UPSTREAM_ID, model)
  const count = await fetch(`${proxy.url.origin}/v1beta/models/${model}:countTokens`, { method: "POST", headers: { "x-goog-api-key": "fixture-client" }, body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] }) })
  assert.equal(count.status, 200)
  assert.equal(count.headers.get("x-raven-token-count"), "estimate")
  h.bind(provider.id, model)
  const text = await run("text", ["-p", "Reply exactly TEXT_FIXTURE_OK. Do not use tools.", "--output-format", "json"])
  assert.equal(JSON.parse(text).response, "TEXT_FIXTURE_OK")
  assert.equal(hits.length, 1)
  phase = "tool"
  const tool = await run("tool", ["-p", "Read line 1 of fixture.txt using read_file, then reply TOOL_FIXTURE_OK.", "--output-format", "json"])
  assert.equal(JSON.parse(tool).response, "TOOL_FIXTURE_OK")
  assert.equal(hits.length, 3)
  phase = "blocked-tool"
  const blocked = JSON.parse(await run("blocked-tool", ["-p", "Read fixture.txt using read_file.", "--output-format", "json"]))
  assert.equal(blocked.response, "TOOL_BLOCKED")
  assert.equal(blocked.stats.tools.totalCalls, 0)
  assert.equal(hits.length, 4)
  assert.deepEqual(fixtureErrors, [])
  writeFileSync(join(artifacts, "report.json"), JSON.stringify({ passed: true, version, requests: requests.map(item => item.path), upstreamRequests: hits.length, text: JSON.parse(text).stats, tool: JSON.parse(tool).stats, blockedTool: blocked.stats }, null, 2))
  console.log(`Gemini CLI text, tool round-trip and interrupted-tool rejection passed (${version}): ${artifacts}`)
} finally {
  writeFileSync(join(artifacts, "requests.json"), JSON.stringify(requests, null, 2))
  writeFileSync(join(artifacts, "upstream.json"), JSON.stringify(hits, null, 2))
  globalThis.fetch = originalFetch
  proxy.stop(true)
  receiver.stop(true)
  h.close()
  assert.ok(resolve(runtime).startsWith(`${artifacts}/`))
  rmSync(runtime, { recursive: true, force: true })
}

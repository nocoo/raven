import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
const { proxyUrl } = vi.hoisted(() => ({ proxyUrl: vi.fn() }))
vi.mock("../../src/lib/socks5-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/socks5-bridge")>(),
  getProxyUrl: proxyUrl,
}))
import { getModels } from "../../src/services/copilot/get-models"
import { getCopilotToken } from "../../src/services/github/get-copilot-token"
import { getDeviceCode } from "../../src/services/github/get-device-code"
import { getGitHubUser } from "../../src/services/github/get-user"
import { getCopilotUsage } from "../../src/services/github/get-copilot-usage"
import { HTTPError } from "../../src/lib/error"
import { state } from "../../src/lib/state"

const originalState = { ...state }
const fetcher = vi.fn()
beforeEach(() => {
  proxyUrl.mockReturnValue("http://proxy.fixture.test:1234")
  fetcher.mockReset()
  vi.stubGlobal("fetch", fetcher)
  state.githubToken = "synthetic-token"
  state.copilotToken = "synthetic-token"
  state.accountType = "individual"
})
afterEach(() => { Object.assign(state, originalState); vi.unstubAllGlobals() })

describe.each([
  ["models", getModels], ["copilot token", getCopilotToken], ["device code", getDeviceCode],
  ["github user", getGitHubUser], ["quota", getCopilotUsage],
])("mocked upstream proxy option: %s", (_name, invoke) => {
  test("passes the configured proxy only to the mocked fetch transport", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ fixture: true }))
    expect(await invoke()).toEqual({ fixture: true })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ proxy: "http://proxy.fixture.test:1234" })
  })
  test("returns a structured HTTP failure without retrying the mocked upstream", async () => {
    fetcher.mockResolvedValueOnce(new Response("fixture denied", { status: 403 }))
    await expect(invoke()).rejects.toBeInstanceOf(HTTPError)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

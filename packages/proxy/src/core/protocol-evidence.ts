import type { ClientProtocol } from "./router"

export interface NativeProtocolEvidence {
  upstream: "copilot"
  model: string
  protocol: ClientProtocol
  stream: boolean
  tested_at: string
  revision: string
  case_id: string
}

export const nativeProtocolEvidence: readonly NativeProtocolEvidence[] = [
  { upstream: "copilot", model: "gemini-3.8-flash", protocol: "openai", stream: false, tested_at: "2026-09-23T01:55:57.865Z", revision: "5ce6b0e76cd3c2d09abfd8d6cf4c975e1222860c", case_id: "gemini-3.8-flash.chat.text.json" },
  { upstream: "copilot", model: "gemini-3.8-flash", protocol: "openai", stream: true, tested_at: "2026-09-23T01:56:03.969Z", revision: "5ce6b0e76cd3c2d09abfd8d6cf4c975e1222860c", case_id: "gemini-3.8-flash.chat.text.sse" },
  { upstream: "copilot", model: "grok-4.5", protocol: "responses", stream: false, tested_at: "2026-09-23T02:02:25.406Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "grok-4.5.responses.text.json" },
  { upstream: "copilot", model: "grok-4.5", protocol: "responses", stream: true, tested_at: "2026-09-23T02:02:27.650Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "grok-4.5.responses.text.sse" },
  { upstream: "copilot", model: "gpt-5.6-sol", protocol: "responses", stream: false, tested_at: "2026-09-23T02:02:30.105Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "gpt-5.6-sol.responses.text.json" },
  { upstream: "copilot", model: "gpt-5.6-sol", protocol: "responses", stream: true, tested_at: "2026-09-23T02:02:32.016Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "gpt-5.6-sol.responses.text.sse" },
  { upstream: "copilot", model: "claude-opus-5.5", protocol: "openai", stream: false, tested_at: "2026-09-23T02:02:33.963Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "claude-opus-5.5.chat.text.json" },
  { upstream: "copilot", model: "claude-opus-5.5", protocol: "openai", stream: true, tested_at: "2026-09-23T02:02:35.991Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "claude-opus-5.5.chat.text.sse" },
  { upstream: "copilot", model: "claude-opus-5.5", protocol: "anthropic", stream: false, tested_at: "2026-09-23T02:02:38.074Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "claude-opus-5.5.messages.text.json" },
  { upstream: "copilot", model: "claude-opus-5.5", protocol: "anthropic", stream: true, tested_at: "2026-09-23T02:02:40.183Z", revision: "0fa3077b7bf2d0518777cfd715198ae42bbf2e5c", case_id: "claude-opus-5.5.messages.text.sse" },
]

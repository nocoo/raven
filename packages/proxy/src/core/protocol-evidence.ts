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

export const nativeProtocolEvidence: readonly NativeProtocolEvidence[] = []

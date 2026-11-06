/**
 * composition/upstream-registry.
 *
 * Single place that knows the full set of upstream client kinds. Returns a
 * fresh client per call so that callers can vary the bound config per
 * request (e.g. when strategies need to inject test fakes).
 */

import {
  CopilotOpenAIClient,
  defaultCopilotOpenAIConfig,
  type CopilotOpenAIConfig,
} from "../upstream/copilot-openai"
import {
  CopilotNativeClient,
  defaultCopilotNativeConfig,
  type CopilotNativeConfig,
} from "../upstream/copilot-native"
import {
  CopilotResponsesClient,
  defaultCopilotResponsesConfig,
  type CopilotResponsesConfig,
} from "../upstream/copilot-responses"
import {
  CopilotEmbeddingsClient,
  defaultCopilotEmbeddingsConfig,
  type CopilotEmbeddingsConfig,
} from "../upstream/copilot-embeddings"
import {
  CustomOpenAIClient,
  defaultCustomOpenAIConfig,
  type CustomOpenAIConfig,
} from "../upstream/custom-openai"
import {
  CustomAnthropicClient,
  defaultCustomAnthropicConfig,
  type CustomAnthropicConfig,
} from "../upstream/custom-anthropic"

import { CustomResponsesClient, defaultCustomResponsesConfig, type CustomResponsesConfig } from "../upstream/custom-responses"
import { CopilotSystemoneClient, defaultCopilotSystemoneConfig, type CopilotSystemoneConfig } from "../upstream/copilot-systemone"
import {
  CopilotNativeJsonClient,
  defaultCopilotNativeJsonConfig,
  type CopilotNativeJsonConfig,
} from "../upstream/copilot-native-json"
import { decisionsFailed, nativeJsonError, type ImageEndpoint } from "../protocols/native-json"

export type UpstreamKind =
  | "copilot-openai"
  | "copilot-native"
  | "copilot-responses"
  | "copilot-systemone"
  | "copilot-decisions"
  | "copilot-images"
  | "copilot-embeddings"
  | "custom-openai"
  | "custom-anthropic"
  | "custom-responses"

export interface UpstreamRegistryDeps {
  fetch?: typeof globalThis.fetch
  allowReplay?: boolean
  requestUsage?: boolean
  customResponses?: CustomResponsesConfig
  copilotOpenAI?: CopilotOpenAIConfig
  copilotNative?: CopilotNativeConfig
  copilotResponses?: CopilotResponsesConfig
  copilotSystemone?: CopilotSystemoneConfig
  copilotDecisions?: CopilotNativeJsonConfig
  copilotImages?: CopilotNativeJsonConfig
  copilotImagesEndpoint?: ImageEndpoint
  copilotEmbeddings?: CopilotEmbeddingsConfig
  customOpenAI?: CustomOpenAIConfig
  customAnthropic?: CustomAnthropicConfig
}

export type UpstreamClientByKind = {
  "copilot-openai": CopilotOpenAIClient
  "copilot-native": CopilotNativeClient
  "copilot-responses": CopilotResponsesClient
  "copilot-systemone": CopilotSystemoneClient
  "copilot-decisions": CopilotNativeJsonClient
  "copilot-images": CopilotNativeJsonClient
  "copilot-embeddings": CopilotEmbeddingsClient
  "custom-openai": CustomOpenAIClient
  "custom-anthropic": CustomAnthropicClient
  "custom-responses": CustomResponsesClient
}

export function buildUpstreamClient<K extends UpstreamKind>(
  kind: K,
  deps: UpstreamRegistryDeps = {},
): UpstreamClientByKind[K] {
  const overrides = {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.allowReplay === undefined ? {} : { allowReplay: deps.allowReplay }),
    ...(deps.requestUsage === undefined ? {} : { requestUsage: deps.requestUsage }),
  }
  switch (kind) {
    case "copilot-systemone":
      return new CopilotSystemoneClient({ ...(deps.copilotSystemone ?? defaultCopilotSystemoneConfig()), ...overrides }) as UpstreamClientByKind[K]
    case "copilot-decisions":
      return new CopilotNativeJsonClient(
        { ...(deps.copilotDecisions ?? defaultCopilotNativeJsonConfig()), ...overrides },
        { path: "/v1/decisions", label: "decisions", failed: decisionsFailed },
      ) as UpstreamClientByKind[K]
    case "copilot-images":
      return new CopilotNativeJsonClient(
        { ...(deps.copilotImages ?? defaultCopilotNativeJsonConfig()), ...overrides },
        { path: deps.copilotImagesEndpoint ?? "/v1/images/generations", label: "images", failed: nativeJsonError },
      ) as UpstreamClientByKind[K]
    case "copilot-openai":
      return new CopilotOpenAIClient(
        { ...(deps.copilotOpenAI ?? defaultCopilotOpenAIConfig()), ...overrides },
      ) as UpstreamClientByKind[K]
    case "copilot-native":
      return new CopilotNativeClient(
        { ...(deps.copilotNative ?? defaultCopilotNativeConfig()), ...overrides },
      ) as UpstreamClientByKind[K]
    case "copilot-responses":
      return new CopilotResponsesClient(
        { ...(deps.copilotResponses ?? defaultCopilotResponsesConfig()), ...overrides },
      ) as UpstreamClientByKind[K]
    case "copilot-embeddings":
      return new CopilotEmbeddingsClient(
        { ...(deps.copilotEmbeddings ?? defaultCopilotEmbeddingsConfig()), ...overrides },
      ) as UpstreamClientByKind[K]
    case "custom-openai":
      return new CustomOpenAIClient(
        { ...(deps.customOpenAI ?? defaultCustomOpenAIConfig()), ...overrides },
      ) as UpstreamClientByKind[K]
    case "custom-anthropic":
      return new CustomAnthropicClient(
        { ...(deps.customAnthropic ?? defaultCustomAnthropicConfig()), ...overrides },
      ) as UpstreamClientByKind[K]
    case "custom-responses":
      return new CustomResponsesClient({ ...(deps.customResponses ?? defaultCustomResponsesConfig()), ...overrides }) as UpstreamClientByKind[K]
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown upstream kind: ${String(exhaustive)}`)
    }
  }
}

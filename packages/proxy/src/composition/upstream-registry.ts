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

export type UpstreamKind =
  | "copilot-openai"
  | "copilot-native"
  | "copilot-responses"
  | "copilot-embeddings"
  | "custom-openai"
  | "custom-anthropic"

export interface UpstreamRegistryDeps {
  copilotOpenAI?: CopilotOpenAIConfig
  copilotNative?: CopilotNativeConfig
  copilotResponses?: CopilotResponsesConfig
  copilotEmbeddings?: CopilotEmbeddingsConfig
  customOpenAI?: CustomOpenAIConfig
  customAnthropic?: CustomAnthropicConfig
}

export type UpstreamClientByKind = {
  "copilot-openai": CopilotOpenAIClient
  "copilot-native": CopilotNativeClient
  "copilot-responses": CopilotResponsesClient
  "copilot-embeddings": CopilotEmbeddingsClient
  "custom-openai": CustomOpenAIClient
  "custom-anthropic": CustomAnthropicClient
}

export function buildUpstreamClient<K extends UpstreamKind>(
  kind: K,
  deps: UpstreamRegistryDeps = {},
): UpstreamClientByKind[K] {
  switch (kind) {
    case "copilot-openai":
      return new CopilotOpenAIClient(
        deps.copilotOpenAI ?? defaultCopilotOpenAIConfig(),
      ) as UpstreamClientByKind[K]
    case "copilot-native":
      return new CopilotNativeClient(
        deps.copilotNative ?? defaultCopilotNativeConfig(),
      ) as UpstreamClientByKind[K]
    case "copilot-responses":
      return new CopilotResponsesClient(
        deps.copilotResponses ?? defaultCopilotResponsesConfig(),
      ) as UpstreamClientByKind[K]
    case "copilot-embeddings":
      return new CopilotEmbeddingsClient(
        deps.copilotEmbeddings ?? defaultCopilotEmbeddingsConfig(),
      ) as UpstreamClientByKind[K]
    case "custom-openai":
      return new CustomOpenAIClient(
        deps.customOpenAI ?? defaultCustomOpenAIConfig(),
      ) as UpstreamClientByKind[K]
    case "custom-anthropic":
      return new CustomAnthropicClient(
        deps.customAnthropic ?? defaultCustomAnthropicConfig(),
      ) as UpstreamClientByKind[K]
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown upstream kind: ${String(exhaustive)}`)
    }
  }
}

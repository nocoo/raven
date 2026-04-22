/**
 * Step 0.1 — Refactor E2E scenario skeleton.
 *
 * Per docs/20-architecture-refactor.md §4.3, these tests exercise every
 * strategy with 2–3 real models × {stream, non-stream} × {tools, no-tools}.
 *
 * Step 0.1 ships the skeleton as `.skip` placeholders. Steps 0.3–0.8 fill
 * them in and capture golden SSE + request_end fixtures.
 *
 * Run with anti-ban suspended (§1.2): `bun run test:e2e:full`. This suite
 * is NEVER auto-run in CI or pre-commit — manual only.
 */
import { describe, test, beforeAll, setDefaultTimeout } from "bun:test";
import { isProxyReachable, API_KEY } from "./helpers";

setDefaultTimeout(120_000);

let proxyUp = false;
beforeAll(async () => {
  proxyUp = await isProxyReachable();
  if (!proxyUp) {
    console.warn("Refactor E2E suite skipped: proxy not reachable on :7024");
  } else if (!API_KEY) {
    console.warn("Refactor E2E suite skipped: RAVEN_API_KEY not set");
  }
});

const filled = (): boolean =>
  proxyUp && API_KEY !== "" && process.env.RAVEN_CAPTURE_GOLDENS !== undefined;

describe("refactor E2E — scenario skeleton (§4.3)", () => {
  describe("CopilotNative", () => {
    test.skipIf(!filled())("claude-opus-4.6 stream", () => {});
    test.skipIf(!filled())("claude-opus-4.6 non-stream", () => {});
    test.skipIf(!filled())("claude-opus-4.6 tool_use", () => {});
    test.skipIf(!filled())("claude-opus-4.6 web_search", () => {});
    test.skipIf(!filled())("claude-sonnet-4.6 stream", () => {});
    test.skipIf(!filled())("claude-sonnet-4.6 non-stream", () => {});
  });

  describe("CopilotTranslated", () => {
    test.skipIf(!filled())("gpt-5 stream", () => {});
    test.skipIf(!filled())("gpt-5 non-stream", () => {});
    test.skipIf(!filled())("gpt-5 tool_use", () => {});
    test.skipIf(!filled())("gpt-5 web_search", () => {});
    test.skipIf(!filled())("reasoning model stream", () => {});
    test.skipIf(!filled())("reasoning model non-stream", () => {});
  });

  describe("CopilotOpenAIDirect", () => {
    test.skipIf(!filled())("gpt-5 stream", () => {});
    test.skipIf(!filled())("gpt-5 non-stream", () => {});
    test.skipIf(!filled())("gpt-5 max_tokens normalisation", () => {});
    test.skipIf(!filled())("secondary model stream", () => {});
  });

  describe("CopilotResponses", () => {
    test.skipIf(!filled())("gpt-5 stream event ordering", () => {});
    test.skipIf(!filled())("gpt-5 non-stream", () => {});
    test.skipIf(!filled())("reasoning model stream", () => {});
    test.skipIf(!filled())("response.failed path", () => {});
  });

  describe("CustomOpenAI", () => {
    test.skipIf(!filled())("provider A reasoning stream", () => {});
    test.skipIf(!filled())("provider A reasoning non-stream", () => {});
    test.skipIf(!filled())("provider B non-reasoning stream", () => {});
    test.skipIf(!filled())("anthropic-client translated", () => {});
  });

  describe("CustomAnthropic", () => {
    test.skipIf(!filled())("provider stream model-1", () => {});
    test.skipIf(!filled())("provider non-stream model-1", () => {});
    test.skipIf(!filled())("provider stream model-2", () => {});
  });
});

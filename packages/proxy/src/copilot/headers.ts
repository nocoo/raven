import { getVSCodeVersion } from "./vscode.ts";

/**
 * Build the VS Code impersonation headers required by Copilot API.
 */
export function buildCopilotHeaders(copilotJwt: string): Record<string, string> {
  return {
    authorization: `Bearer ${copilotJwt}`,
    "editor-version": `vscode/${getVSCodeVersion()}`,
    "editor-plugin-version": "copilot-chat/0.26.7",
    "user-agent": "GitHubCopilotChat/0.26.7",
    "copilot-integration-id": "vscode-chat",
    "openai-intent": "conversation-panel",
    "x-github-api-version": "2025-04-01",
    "x-request-id": globalThis.crypto.randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  };
}

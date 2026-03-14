import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_SCOPES = "read:user";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

/**
 * Step 1: Request a device code from GitHub.
 */
export async function requestDeviceCode(
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<DeviceCodeResponse> {
  const res = await fetchFn("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPES,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Step 2: Poll GitHub for the access token after user enters the device code.
 */
export async function pollAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string> {
  const pollUrl = "https://github.com/login/oauth/access_token";

  while (true) {
    await new Promise((resolve) =>
      setTimeout(resolve, intervalSeconds * 1000),
    );

    const res = await fetchFn(pollUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await res.json();

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === "authorization_pending") {
      continue;
    }

    if (data.error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }

    // Fatal errors
    throw new Error(data.error || "Unknown polling error");
  }
}

/**
 * Save GitHub OAuth token to disk with 0600 permissions.
 */
export function saveToken(tokenPath: string, token: string): void {
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(tokenPath, token, "utf-8");
  chmodSync(tokenPath, 0o600);
}

/**
 * Load GitHub OAuth token from disk.
 * Returns null if file doesn't exist or is corrupted.
 * Deletes corrupted files to trigger re-authentication.
 */
export function loadToken(tokenPath: string): string | null {
  if (!existsSync(tokenPath)) {
    return null;
  }

  try {
    const content = readFileSync(tokenPath, "utf-8").trim();

    if (!content) {
      // Corrupted: empty file
      unlinkSync(tokenPath);
      return null;
    }

    return content;
  } catch {
    // Corrupted: can't read
    try {
      unlinkSync(tokenPath);
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
}

/**
 * Full device flow: request code, prompt user, poll for token, save.
 */
export async function authenticate(
  tokenPath: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<string> {
  // Try loading existing token first
  const existing = loadToken(tokenPath);
  if (existing) {
    return existing;
  }

  // Start device flow
  const deviceCode = await requestDeviceCode(fetchFn);

  console.log("\n🔑 GitHub Device Authentication");
  console.log(`   Open: ${deviceCode.verification_uri}`);
  console.log(`   Code: ${deviceCode.user_code}\n`);

  const token = await pollAccessToken(
    deviceCode.device_code,
    deviceCode.interval,
    fetchFn,
  );

  saveToken(tokenPath, token);
  console.log("✅ Authentication successful\n");

  return token;
}

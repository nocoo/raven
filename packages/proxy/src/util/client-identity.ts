// ---------------------------------------------------------------------------
// Client identity parsing — extracts session ID and client metadata from
// incoming request signals (User-Agent header, body user fields).
// ---------------------------------------------------------------------------

export interface ClientIdentity {
  /** Composite session key for grouping parallel sessions */
  sessionId: string;
  /** Human-readable client name: "Claude Code", "Cursor", "Unknown", etc. */
  clientName: string;
  /** Raw client version if parseable, e.g. "1.2.3" */
  clientVersion: string | null;
}

// ---------------------------------------------------------------------------
// User-Agent → clientName mapping
// ---------------------------------------------------------------------------

const UA_PATTERNS: [RegExp, string][] = [
  [/^claude-code\//, "Claude Code"],
  [/^cursor\//, "Cursor"],
  [/^continue\//, "Continue"],
  [/^windsurf\//, "Windsurf"],
  [/^aider\//, "Aider"],
  [/^cline\//, "Cline"],
  [/^anthropic-python\//, "Anthropic Python SDK"],
  [/^anthropic-typescript\//, "Anthropic TS SDK"],
  [/^openai-python\//, "OpenAI Python SDK"],
  [/^openai-node\//, "OpenAI Node SDK"],
];

/**
 * Parse User-Agent string to extract client name and version.
 */
export function parseUserAgent(
  ua: string | undefined,
): { name: string; version: string | null } {
  if (!ua) return { name: "Unknown", version: null };

  for (const [pattern, name] of UA_PATTERNS) {
    if (pattern.test(ua)) {
      const slashIdx = ua.indexOf("/");
      const version =
        slashIdx >= 0 ? (ua.slice(slashIdx + 1).split(" ")[0] ?? null) : null;
      return { name, version };
    }
  }

  // Fallback: first token before space
  const firstToken = ua.split(" ")[0] ?? ua;
  return { name: firstToken, version: null };
}

// ---------------------------------------------------------------------------
// Session ID derivation
// ---------------------------------------------------------------------------

/**
 * Derive a composite client identity from available signals.
 *
 * Priority:
 * 1. anthropicUserId (Anthropic metadata.user_id) — exact per-session UUID
 * 2. openaiUser (OpenAI payload.user) — heuristic, combined with clientName + accountName
 * 3. Fallback — "{clientName}::{accountName}"
 */
export function deriveClientIdentity(
  anthropicUserId: string | undefined,
  userAgent: string | undefined,
  accountName: string,
  openaiUser?: string,
): ClientIdentity {
  const { name, version } = parseUserAgent(userAgent);

  let sessionId: string;
  if (anthropicUserId) {
    sessionId = anthropicUserId;
  } else if (openaiUser) {
    sessionId = `${openaiUser}::${name}::${accountName}`;
  } else {
    sessionId = `${name}::${accountName}`;
  }

  return { sessionId, clientName: name, clientVersion: version };
}

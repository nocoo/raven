/**
 * Tavily Search API client for server-side web_search tool replacement.
 *
 * API docs: https://tavily.com/docs
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input parameters from Anthropic's web_search tool.
 */
export interface WebSearchInput {
  query: string
  count?: number
  offset?: number
  offset_encoding?: "text" | "none"
}

/**
 * Tavily API request parameters.
 */
export interface TavilySearchRequest {
  query: string
  search_depth?: "basic" | "advanced" | "fast"
  max_results?: number
  include_domains?: string[]
  exclude_domains?: string[]
  include_answer?: boolean
  include_raw_content?: boolean
  topic?: "general" | "news" | "finance"
  days?: number
  max_images?: number
  images_location?: "inline" | "append"
}

/**
 * Tavily API response.
 */
export interface TavilySearchResponse {
  query: string
  results: TavilyResult[]
  answer?: string
  response_time: number
  images?: Array<{
    url: string
    description: string
  }>
}

export interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
  raw_content?: string
}

/**
 * Anthropic web_search_tool_result format.
 */
export interface WebSearchToolResult {
  type: "web_search_tool_result"
  content: string
  citations: Array<{
    url: string
    title: string
    index: number
    extract?: string
  }>
  encrypted_content: null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TavilyError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public type: "auth" | "rate_limit" | "timeout" | "upstream" | "unknown",
  ) {
    super(message)
    this.name = "TavilyError"
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const TAVILY_API_URL = "https://api.tavily.com/search"
const DEFAULT_MAX_RESULTS = 10
const REQUEST_TIMEOUT = 30_000 // 30 seconds

/**
 * Execute a Tavily search with the given API key and query.
 *
 * @throws {TavilyError} For authentication, rate limit, timeout, and upstream errors.
 */
export async function searchTavily(
  apiKey: string,
  input: WebSearchInput,
): Promise<WebSearchToolResult> {
  if (!apiKey || apiKey.trim() === "") {
    throw new TavilyError("API key not configured", 500, "auth")
  }

  // Map Anthropic web_search input to Tavily request
  const tavilyRequest: TavilySearchRequest = {
    query: input.query,
    max_results: Math.min(input.count ?? DEFAULT_MAX_RESULTS, 20),
    search_depth: "basic",
    include_answer: true,
    topic: "general",
  }

  // AbortController for timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

  try {
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tavilyRequest),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    // Handle authentication errors
    if (response.status === 401 || response.status === 403) {
      throw new TavilyError(
        "Invalid Tavily API key",
        response.status,
        "auth",
      )
    }

    // Handle rate limit
    if (response.status === 429) {
      throw new TavilyError(
        "Tavily rate limit exceeded",
        response.status,
        "rate_limit",
      )
    }

    // Handle other errors
    if (!response.ok) {
      throw new TavilyError(
        `Tavily API error: ${response.status} ${response.statusText}`,
        response.status,
        "upstream",
      )
    }

    const data = (await response.json()) as TavilySearchResponse
    return formatWebSearchResult(data)
  } catch (err) {
    clearTimeout(timeoutId)

    if (err instanceof TavilyError) {
      throw err
    }

    // Handle timeout
    if (err instanceof Error && err.name === "AbortError") {
      throw new TavilyError("Tavily request timeout", 408, "timeout")
    }

    // Handle network errors
    if (err instanceof Error) {
      throw new TavilyError(
        `Tavily request failed: ${err.message}`,
        502,
        "upstream",
      )
    }

    throw new TavilyError("Unknown Tavily error", 500, "unknown")
  }
}

/**
 * Format Tavily response as Anthropic web_search_tool_result.
 */
export function formatWebSearchResult(
  tavilyResponse: TavilySearchResponse,
): WebSearchToolResult {
  const results = tavilyResponse.results

  // Handle empty results
  if (results.length === 0) {
    return {
      type: "web_search_tool_result",
      content: "No results found",
      citations: [],
      encrypted_content: null,
    }
  }

  // Build content text
  let text = ""

  // Add AI-generated answer if available
  if (tavilyResponse.answer) {
    text += tavilyResponse.answer + "\n\n"
  }

  // Add search results
  text += results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`,
    )
    .join("\n\n")

  // Build citations
  const citations = results.map((r, i) => ({
    url: r.url,
    title: r.title,
    index: i,
    extract: r.content.slice(0, 200),
  }))

  return {
    type: "web_search_tool_result",
    content: text,
    citations,
    encrypted_content: null,
  }
}

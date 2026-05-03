import { describe, expect, test, beforeEach, afterEach, vi } from "vitest"
import {
  searchTavily,
  formatWebSearchResult,
  TavilyError,
  type TavilySearchResponse,
} from "../../../src/lib/server-tools/tavily"

describe("tavily", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe("searchTavily", () => {
    const apiKey = "tvly-test-key-12345"

    test("rejects empty API key", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      )

      await expect(searchTavily("", { query: "test" })).rejects.toThrow(
        "API key not configured",
      )
    })

    test("sends correct request params", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query: "test query",
            results: [],
          }),
          { status: 200 },
        ),
      )

      await searchTavily(apiKey, { query: "test query", count: 5 })

      const call = fetchSpy.mock.calls[0]
      expect(call).toBeDefined()
      const [url, options] = call as unknown as [string, RequestInit]
      expect(url).toBe("https://api.tavily.com/search")
      expect(options.method).toBe("POST")
      expect(options.headers).toMatchObject({
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      })

      const body = JSON.parse(options.body as string)
      expect(body.query).toBe("test query")
      expect(body.max_results).toBe(5)
      expect(body.search_depth).toBe("basic")
      expect(body.include_answer).toBe(true)
    })

    test("caps max_results at 20", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ query: "test", results: [] }), {
          status: 200,
        }),
      )

      await searchTavily(apiKey, { query: "test", count: 100 })

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      )
      expect(body.max_results).toBe(20)
    })

    test("uses default max_results when count not provided", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ query: "test", results: [] }), {
          status: 200,
        }),
      )

      await searchTavily(apiKey, { query: "test" })

      const body = JSON.parse(
        (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      )
      expect(body.max_results).toBe(10)
    })

    test("returns formatted web_search_tool_result on success", async () => {
      const mockResponse: TavilySearchResponse = {
        query: "test query",
        results: [
          {
            title: "Test Result",
            url: "https://example.com",
            content: "Test content",
            score: 0.99,
          },
        ],
        answer: "AI summary",
        response_time: 0.5,
      }

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      )

      const result = await searchTavily(apiKey, { query: "test query" })

      expect(result.type).toBe("web_search_tool_result")
      // content is array of web_search_result items
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toMatchObject({
        type: "web_search_result",
        url: "https://example.com",
        title: "Test Result",
      })
      expect(result.content[0]!.encrypted_content).toBeTruthy()
      // textContent contains formatted text for synthesis
      expect(result.textContent).toContain("AI summary")
      expect(result.textContent).toContain("Test Result")
      expect(result.textContent).toContain("https://example.com")
    })

    test("handles empty results", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ query: "test", results: [] }),
          { status: 200 },
        ),
      )

      const result = await searchTavily(apiKey, { query: "test" })

      expect(result.content).toHaveLength(0)
      expect(result.textContent).toBe("No results found")
    })

    describe("error handling", () => {
      test("throws TavilyError for 401", async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: "Invalid API key" }),
            { status: 401 },
          ),
        )

        const err = await searchTavily(apiKey, { query: "test" }).catch((e) => e)
        expect(err).toBeInstanceOf(TavilyError)
        expect((err as TavilyError).type).toBe("auth")
        expect((err as TavilyError).statusCode).toBe(401)
      })

      test("throws TavilyError for 403", async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
          }),
        )

        const err = await searchTavily(apiKey, { query: "test" }).catch((e) => e)
        expect(err).toBeInstanceOf(TavilyError)
        expect((err as TavilyError).type).toBe("auth")
        expect((err as TavilyError).statusCode).toBe(403)
      })

      test("throws TavilyError for 429", async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Rate limit" }), {
            status: 429,
          }),
        )

        const err = await searchTavily(apiKey, { query: "test" }).catch((e) => e)
        expect(err).toBeInstanceOf(TavilyError)
        expect((err as TavilyError).type).toBe("rate_limit")
        expect((err as TavilyError).statusCode).toBe(429)
      })

      test("throws TavilyError for 500", async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Internal error" }), {
            status: 500,
          }),
        )

        const err = await searchTavily(apiKey, { query: "test" }).catch((e) => e)
        expect(err).toBeInstanceOf(TavilyError)
        expect((err as TavilyError).type).toBe("upstream")
        expect((err as TavilyError).statusCode).toBe(500)
      })

      test("throws TavilyError for network error", async () => {
        fetchSpy.mockRejectedValueOnce(new Error("Network error"))

        const err = await searchTavily(apiKey, { query: "test" }).catch((e) => e)
        expect(err).toBeInstanceOf(TavilyError)
        expect((err as TavilyError).type).toBe("upstream")
        expect((err as TavilyError).statusCode).toBe(502)
      })
    })
  })

  describe("formatWebSearchResult", () => {
    test("formats basic results", () => {
      const tavilyResponse: TavilySearchResponse = {
        query: "test",
        results: [
          {
            title: "First Result",
            url: "https://example.com/1",
            content: "First content",
            score: 0.9,
          },
          {
            title: "Second Result",
            url: "https://example.com/2",
            content: "Second content",
            score: 0.8,
          },
        ],
        response_time: 0.5,
      }

      const result = formatWebSearchResult(tavilyResponse)

      expect(result.type).toBe("web_search_tool_result")
      // content is array of web_search_result items
      expect(result.content).toHaveLength(2)
      expect(result.content[0]).toMatchObject({
        type: "web_search_result",
        url: "https://example.com/1",
        title: "First Result",
      })
      expect(result.content[1]).toMatchObject({
        type: "web_search_result",
        url: "https://example.com/2",
        title: "Second Result",
      })
      // encrypted_content is base64 encoded
      expect(result.content[0]!.encrypted_content).toBeTruthy()
      // textContent has formatted text for synthesis
      expect(result.textContent).toContain("First Result")
      expect(result.textContent).toContain("https://example.com/1")
      expect(result.textContent).toContain("First content")
    })

    test("includes AI answer when present", () => {
      const tavilyResponse: TavilySearchResponse = {
        query: "test",
        results: [
          {
            title: "Result",
            url: "https://example.com",
            content: "Content",
            score: 0.9,
          },
        ],
        answer: "This is an AI-generated summary",
        response_time: 0.5,
      }

      const result = formatWebSearchResult(tavilyResponse)

      expect(result.textContent).toMatch(/^This is an AI-generated summary/)
      expect(result.textContent).toContain("Result")
    })

    test("handles empty results", () => {
      const tavilyResponse: TavilySearchResponse = {
        query: "test",
        results: [],
        response_time: 0.5,
      }

      const result = formatWebSearchResult(tavilyResponse)

      expect(result.content).toHaveLength(0)
      expect(result.textContent).toBe("No results found")
    })

    test("encrypted_content is base64 of actual content", () => {
      const tavilyResponse: TavilySearchResponse = {
        query: "test",
        results: [
          {
            title: "Result",
            url: "https://example.com",
            content: "Hello World",
            score: 0.9,
          },
        ],
        response_time: 0.5,
      }

      const result = formatWebSearchResult(tavilyResponse)

      // encrypted_content should be base64 of "Hello World"
      const decoded = Buffer.from(result.content[0]!.encrypted_content, "base64").toString()
      expect(decoded).toBe("Hello World")
    })

    test("includes page_age from published_date", () => {
      const tavilyResponse: TavilySearchResponse = {
        query: "test",
        results: [
          {
            title: "Result",
            url: "https://example.com",
            content: "Content",
            score: 0.9,
            published_date: "March 27, 2026",
          },
        ],
        response_time: 0.5,
      }

      const result = formatWebSearchResult(tavilyResponse)

      expect(result.content[0]!.page_age).toBe("March 27, 2026")
    })
  })
})

import { describe, expect, test } from "bun:test";
import {
	appendFilters,
	buildWhereClause,
	parseAnalyticsFilters,
	type AnalyticsFilterParams,
} from "../../src/db/analytics-filters.ts";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
// buildWhereClause
// ---------------------------------------------------------------------------

describe("buildWhereClause", () => {
	test("returns empty for no filters", () => {
		const result = buildWhereClause({});
		expect(result.where).toBe("");
		expect(result.bindings).toEqual([]);
	});

	test("handles single filter", () => {
		const result = buildWhereClause({ model: "claude-3" });
		expect(result.where).toBe("WHERE model = ?");
		expect(result.bindings).toEqual(["claude-3"]);
	});

	test("handles multiple filters with AND", () => {
		const result = buildWhereClause({ model: "claude-3", status: "error", from: 1000 });
		expect(result.where).toContain("AND");
		expect(result.bindings).toHaveLength(3);
	});

	test("handles time range", () => {
		const result = buildWhereClause({ from: 1000, to: 2000 });
		expect(result.where).toBe("WHERE timestamp >= ? AND timestamp <= ?");
		expect(result.bindings).toEqual([1000, 2000]);
	});

	test("handles path with LIKE", () => {
		const result = buildWhereClause({ path: "/v1/messages" });
		expect(result.where).toBe("WHERE path LIKE ?");
		expect(result.bindings).toEqual(["%/v1/messages%"]);
	});

	test("handles stream boolean true", () => {
		const result = buildWhereClause({ stream: true });
		expect(result.where).toBe("WHERE stream = ?");
		expect(result.bindings).toEqual([1]);
	});

	test("handles stream boolean false", () => {
		const result = buildWhereClause({ stream: false });
		expect(result.where).toBe("WHERE stream = ?");
		expect(result.bindings).toEqual([0]);
	});

	test("handles has_error shortcut", () => {
		const result = buildWhereClause({ has_error: true });
		expect(result.where).toBe("WHERE status = 'error'");
		expect(result.bindings).toEqual([]);
	});

	test("handles latency range", () => {
		const result = buildWhereClause({ min_latency: 100, max_latency: 5000 });
		expect(result.where).toBe("WHERE latency_ms >= ? AND latency_ms <= ?");
		expect(result.bindings).toEqual([100, 5000]);
	});

	test("handles all dimension filters", () => {
		const filters: AnalyticsFilterParams = {
			from: 1000,
			to: 2000,
			model: "claude-3",
			resolved_model: "claude-3-opus",
			strategy: "copilot-native",
			upstream: "my-provider",
			account: "default",
			client: "vscode",
			client_version: "1.0.0",
			session: "sess-123",
			status_code: 200,
			stop_reason: "stop",
			routing_path: "native",
		};
		const result = buildWhereClause(filters);
		expect(result.bindings).toHaveLength(13);
		expect(result.where).toContain("WHERE");
	});

	test("handles status filter", () => {
		const result = buildWhereClause({ status: "success" });
		expect(result.where).toBe("WHERE status = ?");
		expect(result.bindings).toEqual(["success"]);
	});

	test("handles status_code filter", () => {
		const result = buildWhereClause({ status_code: 429 });
		expect(result.where).toBe("WHERE status_code = ?");
		expect(result.bindings).toEqual([429]);
	});

	test("handles stop_reason filter", () => {
		const result = buildWhereClause({ stop_reason: "tool_use" });
		expect(result.where).toBe("WHERE stop_reason = ?");
		expect(result.bindings).toEqual(["tool_use"]);
	});

	test("handles routing_path filter", () => {
		const result = buildWhereClause({ routing_path: "translated" });
		expect(result.where).toBe("WHERE routing_path = ?");
		expect(result.bindings).toEqual(["translated"]);
	});
});

// ---------------------------------------------------------------------------
// appendFilters
// ---------------------------------------------------------------------------

describe("appendFilters", () => {
	test("returns empty when both base and filters are empty", () => {
		const result = appendFilters("", {});
		expect(result.where).toBe("");
		expect(result.bindings).toEqual([]);
	});

	test("returns only base when no filter params", () => {
		const result = appendFilters("timestamp >= 1000", {});
		expect(result.where).toBe("WHERE timestamp >= 1000");
		expect(result.bindings).toEqual([]);
	});

	test("returns only filters when no base condition", () => {
		const result = appendFilters("", { model: "claude-3" });
		expect(result.where).toBe("WHERE model = ?");
		expect(result.bindings).toEqual(["claude-3"]);
	});

	test("combines base and filters with AND", () => {
		const result = appendFilters("timestamp >= 1000", { model: "claude-3", status: "error" });
		expect(result.where).toBe("WHERE timestamp >= 1000 AND model = ? AND status = ?");
		expect(result.bindings).toEqual(["claude-3", "error"]);
	});
});

// ---------------------------------------------------------------------------
// parseAnalyticsFilters (via Hono app to get real Context)
// ---------------------------------------------------------------------------

describe("parseAnalyticsFilters", () => {
	function parse(query: string): AnalyticsFilterParams {
		let result: AnalyticsFilterParams = {};
		const app = new Hono();
		app.get("/test", (c) => {
			result = parseAnalyticsFilters(c);
			return c.json(result);
		});
		// Use Bun's test server to parse query params through a real Hono context
		const req = new Request(`http://localhost/test?${query}`);
		app.fetch(req);
		return result;
	}

	test("parses empty query", () => {
		const filters = parse("");
		expect(filters).toEqual({});
	});

	test("parses from/to as integers", () => {
		const filters = parse("from=1000&to=2000");
		expect(filters.from).toBe(1000);
		expect(filters.to).toBe(2000);
	});

	test("parses model", () => {
		const filters = parse("model=claude-3");
		expect(filters.model).toBe("claude-3");
	});

	test("parses resolved_model", () => {
		const filters = parse("resolved_model=claude-3-opus");
		expect(filters.resolved_model).toBe("claude-3-opus");
	});

	test("parses strategy", () => {
		const filters = parse("strategy=copilot-native");
		expect(filters.strategy).toBe("copilot-native");
	});

	test("parses upstream", () => {
		const filters = parse("upstream=my-provider");
		expect(filters.upstream).toBe("my-provider");
	});

	test("parses account", () => {
		const filters = parse("account=default");
		expect(filters.account).toBe("default");
	});

	test("parses client", () => {
		const filters = parse("client=vscode");
		expect(filters.client).toBe("vscode");
	});

	test("parses client_version", () => {
		const filters = parse("client_version=1.2.3");
		expect(filters.client_version).toBe("1.2.3");
	});

	test("parses session", () => {
		const filters = parse("session=sess-abc");
		expect(filters.session).toBe("sess-abc");
	});

	test("parses path", () => {
		const filters = parse("path=/v1/messages");
		expect(filters.path).toBe("/v1/messages");
	});

	test("parses status", () => {
		const filters = parse("status=error");
		expect(filters.status).toBe("error");
	});

	test("parses status_code as integer", () => {
		const filters = parse("status_code=429");
		expect(filters.status_code).toBe(429);
	});

	test("parses stream=true", () => {
		const filters = parse("stream=true");
		expect(filters.stream).toBe(true);
	});

	test("parses stream=1", () => {
		const filters = parse("stream=1");
		expect(filters.stream).toBe(true);
	});

	test("parses stream=false", () => {
		const filters = parse("stream=false");
		expect(filters.stream).toBe(false);
	});

	test("parses stream=0", () => {
		const filters = parse("stream=0");
		expect(filters.stream).toBe(false);
	});

	test("parses has_error=true", () => {
		const filters = parse("has_error=true");
		expect(filters.has_error).toBe(true);
	});

	test("parses has_error=1", () => {
		const filters = parse("has_error=1");
		expect(filters.has_error).toBe(true);
	});

	test("parses min_latency and max_latency", () => {
		const filters = parse("min_latency=100&max_latency=5000");
		expect(filters.min_latency).toBe(100);
		expect(filters.max_latency).toBe(5000);
	});

	test("parses stop_reason", () => {
		const filters = parse("stop_reason=tool_use");
		expect(filters.stop_reason).toBe("tool_use");
	});

	test("parses routing_path", () => {
		const filters = parse("routing_path=native");
		expect(filters.routing_path).toBe("native");
	});

	test("parses all params together", () => {
		const filters = parse(
			"from=1000&to=2000&model=claude-3&strategy=copilot-native&account=default&client=vscode&session=s1&stream=true&has_error=true&min_latency=50&stop_reason=stop&routing_path=native",
		);
		expect(filters.from).toBe(1000);
		expect(filters.to).toBe(2000);
		expect(filters.model).toBe("claude-3");
		expect(filters.strategy).toBe("copilot-native");
		expect(filters.account).toBe("default");
		expect(filters.client).toBe("vscode");
		expect(filters.session).toBe("s1");
		expect(filters.stream).toBe(true);
		expect(filters.has_error).toBe(true);
		expect(filters.min_latency).toBe(50);
		expect(filters.stop_reason).toBe("stop");
		expect(filters.routing_path).toBe("native");
	});

	test("ignores unknown params", () => {
		const filters = parse("unknown=value&model=claude-3");
		expect(filters.model).toBe("claude-3");
		expect(Object.keys(filters)).toEqual(["model"]);
	});
});

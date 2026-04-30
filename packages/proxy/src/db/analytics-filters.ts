import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported filter params — parsed from query string */
export interface AnalyticsFilterParams {
	from?: number;
	to?: number;
	model?: string;
	resolved_model?: string;
	strategy?: string;
	upstream?: string;
	account?: string;
	client?: string;
	client_version?: string;
	session?: string;
	path?: string;
	status?: string;
	status_code?: number;
	stream?: boolean;
	has_error?: boolean;
	min_latency?: number;
	max_latency?: number;
	stop_reason?: string;
	routing_path?: string;
}

export interface WhereClause {
	where: string;
	bindings: unknown[];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Parse analytics filter params from Hono query string. */
export function parseAnalyticsFilters(c: Context): AnalyticsFilterParams {
	const q = (key: string) => c.req.query(key);
	const filters: AnalyticsFilterParams = {};

	const from = q("from");
	if (from) filters.from = Number.parseInt(from, 10);

	const to = q("to");
	if (to) filters.to = Number.parseInt(to, 10);

	const model = q("model");
	if (model) filters.model = model;

	const resolved_model = q("resolved_model");
	if (resolved_model) filters.resolved_model = resolved_model;

	const strategy = q("strategy");
	if (strategy) filters.strategy = strategy;

	const upstream = q("upstream");
	if (upstream) filters.upstream = upstream;

	const account = q("account");
	if (account) filters.account = account;

	const client = q("client");
	if (client) filters.client = client;

	const clientVersion = q("client_version");
	if (clientVersion) filters.client_version = clientVersion;

	const session = q("session");
	if (session) filters.session = session;

	const path = q("path");
	if (path) filters.path = path;

	const status = q("status");
	if (status) filters.status = status;

	const statusCode = q("status_code");
	if (statusCode) filters.status_code = Number.parseInt(statusCode, 10);

	const stream = q("stream");
	if (stream === "true" || stream === "1") filters.stream = true;
	else if (stream === "false" || stream === "0") filters.stream = false;

	const hasError = q("has_error");
	if (hasError === "true" || hasError === "1") filters.has_error = true;

	const minLatency = q("min_latency");
	if (minLatency) filters.min_latency = Number.parseInt(minLatency, 10);

	const maxLatency = q("max_latency");
	if (maxLatency) filters.max_latency = Number.parseInt(maxLatency, 10);

	const stopReason = q("stop_reason");
	if (stopReason) filters.stop_reason = stopReason;

	const routingPath = q("routing_path");
	if (routingPath) filters.routing_path = routingPath;

	return filters;
}

// ---------------------------------------------------------------------------
// Build WHERE
// ---------------------------------------------------------------------------

/** Build WHERE clause and positional bindings from filter params. */
export function buildWhereClause(filters: AnalyticsFilterParams): WhereClause {
	const conditions: string[] = [];
	const bindings: unknown[] = [];

	if (filters.from !== undefined) {
		conditions.push("timestamp >= ?");
		bindings.push(filters.from);
	}
	if (filters.to !== undefined) {
		conditions.push("timestamp <= ?");
		bindings.push(filters.to);
	}
	if (filters.model) {
		conditions.push("model = ?");
		bindings.push(filters.model);
	}
	if (filters.resolved_model) {
		conditions.push("resolved_model = ?");
		bindings.push(filters.resolved_model);
	}
	if (filters.strategy) {
		conditions.push("strategy = ?");
		bindings.push(filters.strategy);
	}
	if (filters.upstream) {
		conditions.push("upstream = ?");
		bindings.push(filters.upstream);
	}
	if (filters.account) {
		conditions.push("account_name = ?");
		bindings.push(filters.account);
	}
	if (filters.client) {
		conditions.push("client_name = ?");
		bindings.push(filters.client);
	}
	if (filters.client_version) {
		conditions.push("client_version = ?");
		bindings.push(filters.client_version);
	}
	if (filters.session) {
		conditions.push("session_id = ?");
		bindings.push(filters.session);
	}
	if (filters.path) {
		conditions.push("path LIKE ?");
		bindings.push(`%${filters.path}%`);
	}
	if (filters.status) {
		conditions.push("status = ?");
		bindings.push(filters.status);
	}
	if (filters.status_code !== undefined) {
		conditions.push("status_code = ?");
		bindings.push(filters.status_code);
	}
	if (filters.stream !== undefined) {
		conditions.push("stream = ?");
		bindings.push(filters.stream ? 1 : 0);
	}
	if (filters.has_error) {
		conditions.push("status = 'error'");
	}
	if (filters.min_latency !== undefined) {
		conditions.push("latency_ms >= ?");
		bindings.push(filters.min_latency);
	}
	if (filters.max_latency !== undefined) {
		conditions.push("latency_ms <= ?");
		bindings.push(filters.max_latency);
	}
	if (filters.stop_reason) {
		conditions.push("stop_reason = ?");
		bindings.push(filters.stop_reason);
	}
	if (filters.routing_path) {
		conditions.push("routing_path = ?");
		bindings.push(filters.routing_path);
	}

	if (conditions.length === 0) {
		return { where: "", bindings: [] };
	}

	return { where: `WHERE ${conditions.join(" AND ")}`, bindings };
}

/**
 * Append filter conditions to an existing base condition string.
 * If base is non-empty, combines with AND.
 */
export function appendFilters(
	baseCondition: string,
	filters: AnalyticsFilterParams,
): WhereClause {
	const filterClause = buildWhereClause(filters);

	if (!baseCondition && !filterClause.where) {
		return { where: "", bindings: [] };
	}
	if (!baseCondition) {
		return filterClause;
	}
	if (!filterClause.where) {
		return { where: `WHERE ${baseCondition}`, bindings: [] };
	}

	const filterConditions = filterClause.where.replace(/^WHERE\s+/i, "");
	return {
		where: `WHERE ${baseCondition} AND ${filterConditions}`,
		bindings: filterClause.bindings,
	};
}

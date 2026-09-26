import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RoutingError } from "../core/routing-types";
import { parseRules } from "../lib/ip-access";
import { getSetting, setSetting } from "./settings";

export const ipPolicySchema = z.strictObject({ enabled: z.boolean(), ranges: z.array(z.string()).max(256) });
export type IPPolicy = z.infer<typeof ipPolicySchema>;

export function validateIPPolicy(value: unknown): IPPolicy {
  const result = ipPolicySchema.safeParse(value);
  if (!result.success) throw new RoutingError("Expected an enabled flag and an array of IP rules");
  const policy = result.data;
  try { policy.ranges = parseRules(policy.ranges).map(rule => rule.original); }
  catch { throw new RoutingError("Invalid IPv4/IPv6 address, CIDR or range"); }
  if (policy.enabled && policy.ranges.length === 0) throw new RoutingError("A whitelist needs at least one IP rule");
  return policy;
}

export function initIPPolicies(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS key_ip_policies (
    key_id TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    ranges TEXT NOT NULL CHECK(json_valid(ranges))
  )`);
}

export function readIPPolicy(db: Database, keyId: string): IPPolicy {
  if (!db.query("SELECT id FROM api_keys WHERE id = ?").get(keyId)) throw new RoutingError("Key not found", "not_found", 404);
  const row = db.query("SELECT enabled, ranges FROM key_ip_policies WHERE key_id = ?").get(keyId) as { enabled: number; ranges: string } | null;
  return row ? { enabled: row.enabled === 1, ranges: JSON.parse(row.ranges) } : { enabled: false, ranges: [] };
}

export function writeIPPolicy(db: Database, keyId: string, value: unknown): IPPolicy {
  const policy = validateIPPolicy(value);
  readIPPolicy(db, keyId);
  db.query(`INSERT INTO key_ip_policies (key_id, enabled, ranges) VALUES (?, ?, ?)
    ON CONFLICT(key_id) DO UPDATE SET enabled = excluded.enabled, ranges = excluded.ranges`).run(keyId, Number(policy.enabled), JSON.stringify(policy.ranges));
  return policy;
}

export function readGlobalIPPolicy(db: Database): IPPolicy & { trusted_proxies: string[] } {
  return {
    enabled: getSetting(db, "ip_whitelist_enabled") === "true",
    ranges: JSON.parse(getSetting(db, "ip_whitelist_ranges") ?? "[]"),
    trusted_proxies: JSON.parse(getSetting(db, "ip_trusted_proxies") ?? "[]"),
  };
}

export function writeGlobalIPPolicy(db: Database, value: unknown): ReturnType<typeof readGlobalIPPolicy> {
  const result = ipPolicySchema.extend({ trusted_proxies: z.array(z.string()).max(256) }).safeParse(value);
  if (!result.success) throw new RoutingError("Invalid global IP policy");
  const policy = validateIPPolicy({ enabled: result.data.enabled, ranges: result.data.ranges });
  let trusted: string[];
  try { trusted = parseRules(result.data.trusted_proxies).map(rule => rule.original); }
  catch { throw new RoutingError("Invalid trusted proxy rules"); }
  db.transaction(() => {
    setSetting(db, "ip_whitelist_enabled", String(policy.enabled));
    setSetting(db, "ip_whitelist_ranges", JSON.stringify(policy.ranges));
    setSetting(db, "ip_trusted_proxies", JSON.stringify(trusted));
    db.query("DELETE FROM settings WHERE key = 'ip_whitelist_trust_proxy'").run();
  }).immediate();
  return { ...policy, trusted_proxies: trusted };
}

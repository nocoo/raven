import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export function initSettings(db: Database): void {
  db.exec(CREATE_TABLE);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function getSetting(db: Database, key: string): string | null {
  const row = db
    .query("SELECT value FROM settings WHERE key = $key")
    .get({ $key: key }) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = $value",
  ).run({ $key: key, $value: value });
}

export function deleteSetting(db: Database, key: string): boolean {
  const result = db
    .query("DELETE FROM settings WHERE key = $key")
    .run({ $key: key });
  return result.changes > 0;
}

export function getAllSettings(
  db: Database,
): Record<string, string> {
  const rows = db
    .query("SELECT key, value FROM settings")
    .all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

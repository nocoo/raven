// ---------------------------------------------------------------------------
// ULID-like ID generator — timestamp-sortable, no external deps.
// Used as the canonical requestId: DB primary key + log correlation key.
// ---------------------------------------------------------------------------

export function generateRequestId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  )
    .join("")
    .toUpperCase();
  return ts + rand;
}

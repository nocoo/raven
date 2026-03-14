/**
 * Parse a string to integer, returning null if invalid.
 * Rejects NaN, Infinity, negative numbers, and non-integer strings.
 */
export function safeParseInt(value: string, min = 0): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    return null;
  }
  return n;
}

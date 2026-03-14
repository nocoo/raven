/**
 * Get a reasonable VS Code version string.
 * In production, this could dynamically fetch the latest version.
 * For MVP, we use a hardcoded recent version.
 */
export function getVSCodeVersion(): string {
  return "1.99.3";
}

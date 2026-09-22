/** Join a custom provider base with an API path. A base that already ends in /v1 is not doubled. */
export function joinCustomApiUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "")
  const root = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
  return `${root}/${path.replace(/^\/+/, "")}`
}

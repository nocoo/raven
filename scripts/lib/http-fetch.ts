/** Minimal fetch surface for offline tests without Bun's extended Fetch type. */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

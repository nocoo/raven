export function preserveLockfileSources(before: string, after: string): string {
  const packageSource = /^(\s*"[^"\n]+": \["[^"\n]+", )"([^"\n]*)"/gm;
  const sources = new Map(
    Array.from(before.matchAll(packageSource), (match) => [match[1], match[2]]),
  );
  return after.replace(packageSource, (match, prefix: string) =>
    sources.has(prefix) ? `${prefix}${JSON.stringify(sources.get(prefix))}` : match,
  );
}

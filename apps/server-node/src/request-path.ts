/**
 * The raw path of a request target (no query, not percent-decoded), or null when the target is not
 * origin-form (`/path?query`). Routing on the raw path keeps `/api%2F..` out of the API.
 */
export function rawPath(target: string | undefined): string | null {
  if (target === undefined || !target.startsWith('/')) return null;
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

// Post-authentication redirect targets arrive as a `?next=` query param, which
// is attacker-controllable. Only same-origin, in-app paths are safe: reject
// absolute URLs and protocol-relative paths ("//evil.example") — both would
// send a just-authenticated user off-site.
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

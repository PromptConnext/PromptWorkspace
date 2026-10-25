// Post-authentication redirect targets arrive as a `?next=` query param, which
// is attacker-controllable. Only same-origin, in-app paths are safe. Each rule
// closes a way a string that "starts with /" still leaves the origin:
//
// - `//evil.example` is protocol-relative.
// - `/\evil.example`: browsers treat `\` as `/` in http(s) URLs, so it is
//   `//evil.example` again. Any backslash is refused, not just the second char.
// - Tab, CR and LF are stripped by the URL parser, so `/<TAB>/evil.example`
//   collapses to `//evil.example`. Every control character is refused.
// - A `:` in the first segment (`/javascript:…`) is harmless as a path today,
//   but nothing in the app needs one there and it looks like a scheme to any
//   later code that trims the leading slash, so it is refused too.
//
// The consent page relies on this: `/oauth/consent?request=…` must round-trip
// through login, and nothing else may ride along with it.
export function safeNext(raw: string | null): string {
  if (!raw || raw[0] !== "/") return "/";
  if (raw[1] === "/" || raw.includes("\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return "/";
  const firstSegment = raw.slice(1).split(/[/?#]/, 1)[0];
  if (firstSegment.includes(":")) return "/";
  return raw;
}

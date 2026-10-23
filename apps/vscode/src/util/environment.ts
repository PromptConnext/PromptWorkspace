// Which cloud is this window talking to? Silent for production; otherwise the
// host, so a staging or trust environment is never mistaken for production.

export function environmentLabel(apiUrl: string, defaultUrl: string): string | undefined {
  try {
    const host = new URL(apiUrl).host;
    return host === new URL(defaultUrl).host ? undefined : host;
  } catch {
    return undefined;
  }
}

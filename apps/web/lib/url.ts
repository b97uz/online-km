/**
 * Builds a redirect URL from the browser's own origin so the user
 * stays on whatever address they typed (localhost, domain, IP, etc.).
 *
 * The Host header is set by the browser and always matches the address bar.
 * Inside Docker req.url is http://0.0.0.0:3000 but Host is still correct.
 */
export function buildUrl(path: string, req: Request): URL {
  const proto =
    first(req.headers.get("x-forwarded-proto")) || "http";
  const host =
    first(req.headers.get("x-forwarded-host")) ||
    first(req.headers.get("host"));

  if (host) {
    return new URL(path, `${proto}://${host}`);
  }

  const base = process.env.WEB_BASE_URL;
  if (base) {
    return new URL(path, base);
  }

  return new URL(path, req.url);
}

function first(header: string | null): string | undefined {
  if (!header) return undefined;
  const v = header.split(",")[0].trim();
  return v || undefined;
}

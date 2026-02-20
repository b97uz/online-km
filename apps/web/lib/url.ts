/**
 * Builds an absolute URL using the real host from reverse-proxy headers
 * instead of the Docker-internal 0.0.0.0:3000.
 */
export function buildUrl(path: string, req: Request): URL {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host =
    req.headers.get("x-forwarded-host") || req.headers.get("host");
  const origin = host
    ? `${proto}://${host}`
    : process.env.WEB_BASE_URL || req.url;
  return new URL(path, origin);
}

/**
 * Builds an absolute redirect URL.
 *
 * Priority:
 *  1. X-Forwarded-Proto / X-Forwarded-Host headers (set by nginx)
 *  2. WEB_BASE_URL env var
 *  3. The request's own URL (may be Docker-internal 0.0.0.0:3000)
 */
export function buildUrl(path: string, req: Request): URL {
  const fwdProto = req.headers.get("x-forwarded-proto");
  const fwdHost =
    req.headers.get("x-forwarded-host") || req.headers.get("host");

  if (fwdProto && fwdHost) {
    const host = fwdHost.split(",")[0].trim();
    return new URL(path, `${fwdProto.split(",")[0].trim()}://${host}`);
  }

  const base = process.env.WEB_BASE_URL;
  if (base) return new URL(path, base);

  return new URL(path, req.url);
}

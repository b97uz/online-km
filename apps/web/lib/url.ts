/**
 * Builds an absolute redirect URL from the incoming request,
 * so the browser is always sent back to the same origin it came from.
 *
 * Priority:
 *  1. X-Forwarded-Proto + X-Forwarded-Host (nginx / reverse-proxy)
 *  2. X-Forwarded-Proto + Host header
 *  3. WEB_BASE_URL env var
 *  4. Plain Host header over http (direct access)
 */
export function buildUrl(path: string, req: Request): URL {
  const fwdProto = firstVal(req.headers.get("x-forwarded-proto"));
  const fwdHost = firstVal(req.headers.get("x-forwarded-host"));
  const host = firstVal(req.headers.get("host"));

  if (fwdProto && fwdHost) return new URL(path, `${fwdProto}://${fwdHost}`);
  if (fwdProto && host) return new URL(path, `${fwdProto}://${host}`);

  const base = process.env.WEB_BASE_URL;
  if (base) return new URL(path, base);

  if (host) return new URL(path, `http://${host}`);

  return new URL(path, req.url);
}

function firstVal(header: string | null): string | undefined {
  if (!header) return undefined;
  const v = header.split(",")[0].trim();
  return v || undefined;
}

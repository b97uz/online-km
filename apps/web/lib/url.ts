/**
 * Builds an absolute redirect URL that a **browser** can actually follow.
 *
 * Inside Docker the internal host is 0.0.0.0 which is meaningless to a
 * browser, so we must derive the real origin from trusted sources:
 *
 *  1. X-Forwarded-Proto / X-Forwarded-Host  (nginx sets these)
 *  2. WEB_BASE_URL env var                   (docker-compose sets this)
 *
 * We intentionally never fall back to req.url because inside Docker it
 * always contains http://0.0.0.0:3000 which causes ERR_SSL_PROTOCOL_ERROR
 * when Chrome upgrades the scheme to https.
 */
export function buildUrl(path: string, req: Request): URL {
  const fwdProto = first(req.headers.get("x-forwarded-proto"));
  const fwdHost = first(req.headers.get("x-forwarded-host"));

  if (fwdProto && fwdHost) {
    return new URL(path, `${fwdProto}://${fwdHost}`);
  }

  const base = process.env.WEB_BASE_URL;
  if (base) {
    return new URL(path, base);
  }

  // Should never reach here in production -- log a warning so it's visible.
  console.warn(
    "[buildUrl] No X-Forwarded-Host and no WEB_BASE_URL. " +
      "Falling back to request URL:",
    req.url,
  );
  return new URL(path, req.url);
}

function first(header: string | null): string | undefined {
  if (!header) return undefined;
  const v = header.split(",")[0].trim();
  return v || undefined;
}

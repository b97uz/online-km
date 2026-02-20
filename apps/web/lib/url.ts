export function buildUrl(path: string, req: Request): URL {
  const proto = first(req.headers.get("x-forwarded-proto")) || "http";
  const host =
    first(req.headers.get("x-forwarded-host")) ||
    first(req.headers.get("host"));

  if (host) {
    const safeHost = host.replace(/^0\.0\.0\.0/, "localhost");
    return new URL(path, `${proto}://${safeHost}`);
  }

  const base = process.env.WEB_BASE_URL;
  if (base) return new URL(path, base);

  return new URL(path, req.url);
}

function first(header: string | null): string | undefined {
  if (!header) return undefined;
  const v = header.split(",")[0].trim();
  return v || undefined;
}

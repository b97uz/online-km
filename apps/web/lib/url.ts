/**
 * Builds an absolute URL using WEB_BASE_URL env var
 * instead of the Docker-internal 0.0.0.0:3000.
 */
export function buildUrl(path: string, _req: Request): URL {
  const base = process.env.WEB_BASE_URL || "http://localhost:3000";
  return new URL(path, base);
}

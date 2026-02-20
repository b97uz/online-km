import { InstitutionCatalogType, InstitutionType } from "@prisma/client";
import { buildUrl } from "@/lib/url";

export function isJsonRequest(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

export function normalizeLocationName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

export function parseInstitutionType(value: string): InstitutionType | null {
  if (value === "SCHOOL") return InstitutionType.SCHOOL;
  if (value === "LYCEUM_COLLEGE") return InstitutionType.LYCEUM_COLLEGE;
  if (value === "OTHER") return InstitutionType.OTHER;
  return null;
}

export function parseInstitutionCatalogType(value: string): InstitutionCatalogType | null {
  if (value === "SCHOOL") return InstitutionCatalogType.SCHOOL;
  if (value === "LYCEUM_COLLEGE") return InstitutionCatalogType.LYCEUM_COLLEGE;
  return null;
}

export function locationsRedirect(
  req: Request,
  options: {
    tab?: string;
    provinceId?: string | null;
    districtId?: string | null;
    q?: string | null;
    type?: string | null;
    msg?: string;
    error?: string;
  },
) {
  const url = buildUrl("/admin/locations", req);
  if (options.tab) url.searchParams.set("tab", options.tab);
  if (options.provinceId) url.searchParams.set("provinceId", options.provinceId);
  if (options.districtId) url.searchParams.set("districtId", options.districtId);
  if (options.q) url.searchParams.set("q", options.q);
  if (options.type) url.searchParams.set("type", options.type);
  if (options.msg) url.searchParams.set("msg", options.msg);
  if (options.error) url.searchParams.set("error", options.error);
  return url;
}

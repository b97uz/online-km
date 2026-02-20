import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import {
  ExcelImportError,
  importLocationRowsFromExcel,
  parseLocationExcelBuffer,
  type LocationImportType,
} from "@/lib/location-excel-import";
import { isJsonRequest } from "@/lib/locations";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function toImportType(value: string): LocationImportType | null {
  if (value === "SCHOOL") return "SCHOOL";
  if (value === "LYCEUM_COLLEGE") return "LYCEUM_COLLEGE";
  return null;
}

function redirectWithMessage(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/locations/excel-import", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

function isXlsxFile(file: File): boolean {
  const filename = (file.name ?? "").toLowerCase();
  if (filename.endsWith(".xlsx")) return true;
  const mime = (file.type ?? "").toLowerCase();
  return mime.includes("spreadsheetml.sheet");
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const asJson = isJsonRequest(req);
  const form = await req.formData();

  const importType = toImportType(String(form.get("importType") ?? ""));
  if (!importType) {
    const message = "Import turi noto'g'ri. SCHOOL yoki LYCEUM_COLLEGE bo'lishi kerak.";
    if (asJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
    return redirectWithMessage(req, message, true);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    const message = "Excel fayl yuklanmadi.";
    if (asJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
    return redirectWithMessage(req, message, true);
  }

  if (!isXlsxFile(file)) {
    const message = "Faqat .xlsx fayl yuklash mumkin.";
    if (asJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
    return redirectWithMessage(req, message, true);
  }

  try {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const rows = parseLocationExcelBuffer(fileBuffer, importType);
    const summary = await importLocationRowsFromExcel(prisma, session.userId, importType, rows);

    if (asJson) return NextResponse.json({ ok: true, summary });

    const label = importType === "SCHOOL" ? "maktab" : "litsey/kollej";
    const message =
      `Import yakunlandi (${label}): viloyat ${summary.newProvincesCount}, ` +
      `tuman ${summary.newDistrictsCount}, yangi ${label} ${summary.newInstitutionsCount}, ` +
      `skip ${summary.skippedDuplicatesCount}`;
    return redirectWithMessage(req, message, false);
  } catch (error) {
    const message =
      error instanceof ExcelImportError
        ? error.message
        : "Excel importda kutilmagan xatolik yuz berdi.";
    if (asJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
    return redirectWithMessage(req, message, true);
  }
}


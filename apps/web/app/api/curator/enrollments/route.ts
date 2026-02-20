import { getSession } from "@/lib/auth";
import { buildUrl } from "@/lib/url";
import { NextResponse } from "next/server";

function redirectCurator(req: Request, message: string, isError = false) {
  const url = buildUrl("/curator/students", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "CURATOR") return new NextResponse("Forbidden", { status: 403 });

  const asJson = isJson(req);
  if (asJson) {
    return NextResponse.json(
      {
        ok: false,
        error: "Studentni guruhga qo'shish faqat Admin panelda bajariladi.",
      },
      { status: 403 },
    );
  }
  return redirectCurator(req, "Studentni guruhga qo'shish faqat Admin panelda bajariladi.", true);
}

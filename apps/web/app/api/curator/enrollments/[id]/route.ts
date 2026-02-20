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

async function deny(req: Request, asJson: boolean) {
  const session = await getSession();
  if (!session || session.role !== "CURATOR") return new NextResponse("Forbidden", { status: 403 });
  if (asJson) {
    return NextResponse.json(
      {
        ok: false,
        error: "Guruhdagi student holatini o'zgartirish faqat Admin panelda bajariladi.",
      },
      { status: 403 },
    );
  }
  return redirectCurator(req, "Guruhdagi student holatini o'zgartirish faqat Admin panelda bajariladi.", true);
}

export async function PATCH(
  req: Request,
  _context: { params: Promise<{ id: string }> },
) {
  return deny(req, true);
}

export async function DELETE(
  req: Request,
  _context: { params: Promise<{ id: string }> },
) {
  return deny(req, isJson(req));
}

export async function POST(
  req: Request,
  _context: { params: Promise<{ id: string }> },
) {
  return deny(req, false);
}

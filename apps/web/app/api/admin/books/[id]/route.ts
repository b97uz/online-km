import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function redirectTests(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/tests", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

async function deleteBook(req: Request, id: string, asJson: boolean) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const book = await prisma.book.findUnique({ where: { id }, select: { id: true, title: true } });
  if (!book) {
    if (asJson) return NextResponse.json({ ok: false, error: "Kitob topilmadi" }, { status: 404 });
    return redirectTests(req, "Kitob topilmadi", true);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.book.delete({ where: { id: book.id } });
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "DELETE",
          entity: "Book",
          entityId: book.id,
          payload: { title: book.title },
        },
      });
    });

    if (asJson) return NextResponse.json({ ok: true });
    return redirectTests(req, "Kitob o'chirildi");
  } catch (error) {
    console.error("ADMIN_BOOK_DELETE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Kitob o'chirilmadi" }, { status: 500 });
    return redirectTests(req, "Kitob o'chirilmadi", true);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deleteBook(req, id, isJson(req));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const method = String(form.get("_method") ?? "").toUpperCase();
  if (method !== "DELETE") return new NextResponse("Method Not Allowed", { status: 405 });
  return deleteBook(req, id, false);
}

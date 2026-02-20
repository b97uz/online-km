import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const title = String(form.get("title") ?? "").trim();

  if (!title) {
    const errorUrl = buildUrl("/admin/tests", req);
    errorUrl.searchParams.set("error", "Kitob nomi bo'sh bo'lmasligi kerak");
    return NextResponse.redirect(errorUrl, 303);
  }

  try {
    const book = await prisma.book.create({ data: { title } });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "CREATE",
        entity: "Book",
        entityId: book.id,
      },
    });

    const okUrl = buildUrl("/admin/tests", req);
    okUrl.searchParams.set("msg", "Kitob qo'shildi");
    return NextResponse.redirect(okUrl, 303);
  } catch (error) {
    console.error("ADMIN_BOOK_CREATE_ERROR", error);
    const errorUrl = buildUrl("/admin/tests", req);
    errorUrl.searchParams.set("error", "Kitob qo'shilmadi");
    return NextResponse.redirect(errorUrl, 303);
  }
}

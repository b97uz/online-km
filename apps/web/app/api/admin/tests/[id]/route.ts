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

async function deleteTest(req: Request, id: string, asJson: boolean) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const test = await prisma.test.findUnique({
    where: { id },
    include: {
      lesson: {
        include: {
          book: true,
        },
      },
    },
  });

  if (!test) {
    if (asJson) return NextResponse.json({ ok: false, error: "Test topilmadi" }, { status: 404 });
    return redirectTests(req, "Test topilmadi", true);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.test.delete({ where: { id: test.id } });

      const remainingTests = await tx.test.count({ where: { lessonId: test.lessonId } });
      if (remainingTests === 0) {
        await tx.lesson.delete({ where: { id: test.lessonId } });
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "DELETE",
          entity: "Test",
          entityId: test.id,
          payload: {
            book: test.lesson.book.title,
            lessonNumber: test.lesson.lessonNumber,
            lessonTitle: test.lesson.title,
          },
        },
      });
    });

    if (asJson) return NextResponse.json({ ok: true });
    return redirectTests(req, "Test o'chirildi");
  } catch (error) {
    console.error("ADMIN_TEST_DELETE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Test o'chirilmadi" }, { status: 500 });
    return redirectTests(req, "Test o'chirilmadi", true);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deleteTest(req, id, isJson(req));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const method = String(form.get("_method") ?? "").toUpperCase();
  if (method !== "DELETE") return new NextResponse("Method Not Allowed", { status: 405 });
  return deleteTest(req, id, false);
}

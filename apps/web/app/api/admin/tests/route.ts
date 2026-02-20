import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const bookId = String(form.get("bookId") ?? "").trim();
  const lessonNumber = Number(form.get("lessonNumber") ?? 1);
  const lessonTitle = String(form.get("lessonTitle") ?? "").trim();
  const totalQuestions = Number(form.get("totalQuestions") ?? 30);
  const answerKeyRaw = String(form.get("answerKey") ?? "");
  const imageUrl1 = String(form.get("imageUrl1") ?? "").trim();
  const imageUrl2 = String(form.get("imageUrl2") ?? "").trim();

  const answerKey = answerKeyRaw
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  if (
    !bookId ||
    !lessonTitle ||
    !imageUrl1 ||
    !imageUrl2 ||
    !Number.isFinite(lessonNumber) ||
    lessonNumber < 1 ||
    !Number.isFinite(totalQuestions) ||
    totalQuestions < 1
  ) {
    const errorUrl = buildUrl("/admin/tests", req);
    errorUrl.searchParams.set("error", "Test ma'lumotlari noto'g'ri");
    return NextResponse.redirect(errorUrl, 303);
  }

  if (answerKey.length !== totalQuestions) {
    const errorUrl = buildUrl("/admin/tests", req);
    errorUrl.searchParams.set("error", "Answer key soni savollar soniga teng bo'lishi kerak");
    return NextResponse.redirect(errorUrl, 303);
  }

  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { id: true } });
  if (!book) {
    const errorUrl = buildUrl("/admin/tests", req);
    errorUrl.searchParams.set("error", "Kitob topilmadi");
    return NextResponse.redirect(errorUrl, 303);
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingLesson = await tx.lesson.findUnique({
        where: {
          bookId_lessonNumber: {
            bookId,
            lessonNumber,
          },
        },
      });

      const lesson = existingLesson
        ? await tx.lesson.update({
            where: { id: existingLesson.id },
            data: { title: lessonTitle },
          })
        : await tx.lesson.create({
            data: { bookId, lessonNumber, title: lessonTitle },
          });

      const test = await tx.test.create({
        data: {
          lessonId: lesson.id,
          totalQuestions,
          answerKey,
          telegramGroupLink: null,
        },
      });

      await tx.testImage.createMany({
        data: [
          { testId: test.id, pageNumber: 1, imageUrl: imageUrl1 },
          { testId: test.id, pageNumber: 2, imageUrl: imageUrl2 },
        ],
      });

      return { lesson, test };
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "CREATE",
        entity: "Test",
        entityId: result.test.id,
      },
    });

    const okUrl = buildUrl("/admin/tests", req);
    okUrl.searchParams.set("msg", "Test qo'shildi");
    return NextResponse.redirect(okUrl, 303);
  } catch (error) {
    console.error("ADMIN_TEST_CREATE_ERROR", error);
    const errorUrl = buildUrl("/admin/tests", req);
    errorUrl.searchParams.set("error", "Test qo'shilmadi");
    return NextResponse.redirect(errorUrl, 303);
  }
}

import { AppealStatus } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { parentReplyKeyboard, sendTelegramMessage, studentReplyKeyboard } from "@/lib/telegram-bot";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function redirectAppeals(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/appeals", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const { id } = await params;

  const appeal = await prisma.appeal.findUnique({
    where: { id },
    include: {
      student: {
        select: {
          fullName: true,
        },
      },
    },
  });

  if (!appeal) return redirectAppeals(req, "E'tiroz topilmadi", true);

  if (appeal.status === AppealStatus.RESOLVED) {
    return redirectAppeals(req, "E'tiroz allaqachon hal qilingan");
  }

  try {
    const updated = await prisma.appeal.update({
      where: { id: appeal.id },
      data: {
        status: AppealStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedById: session.userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "UPDATE",
        entity: "Appeal",
        entityId: updated.id,
        payload: { status: AppealStatus.RESOLVED },
      },
    });

    const resolutionText =
      "✅ Muammoingiz hal bo'ldi.\n" +
      "Yana boshqa e'tirozlaringiz bo'lsa, e'tirozingizni yozishingiz mumkin.";

    await sendTelegramMessage(
      appeal.senderTelegramUserId,
      resolutionText,
      {
        replyMarkup: appeal.senderType === "STUDENT" ? studentReplyKeyboard() : parentReplyKeyboard(),
      },
    );

    return redirectAppeals(req, `E'tiroz hal qilindi: ${appeal.student.fullName}`);
  } catch (error) {
    console.error("ADMIN_APPEAL_RESOLVE_ERROR", error);
    return redirectAppeals(req, "E'tirozni hal qilishda xatolik", true);
  }
}

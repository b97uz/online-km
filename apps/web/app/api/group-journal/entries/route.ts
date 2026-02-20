import { prisma } from "@km/db";
import { EnrollmentStatus } from "@prisma/client";
import { getSession } from "@/lib/auth";
import {
  canAccessGroupForJournal,
  formatJournalAttendance,
  formatUzDateOnly,
  parseJournalAttendance,
  startOfTodayUtc,
} from "@/lib/group-journal";
import { parentReplyKeyboard, sendTelegramMessage, studentReplyKeyboard } from "@/lib/telegram-bot";
import { buildUrl } from "@/lib/url";
import { NextResponse } from "next/server";

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function getRedirectPath(raw: string, role: "ADMIN" | "CURATOR", groupId?: string): string {
  const path = raw.trim();
  if (path.startsWith("/admin/groups/") || path.startsWith("/curator/groups/")) return path;

  if (groupId) {
    return role === "ADMIN" ? `/admin/groups/${groupId}` : `/curator/groups/${groupId}`;
  }
  return role === "ADMIN" ? "/admin/groups" : "/curator/groups";
}

function redirectTo(req: Request, path: string, message: string, isError = false) {
  const url = buildUrl(path, req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

function parseScoreField(raw: string): { ok: true; value: number | null } | { ok: false } {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (!/^\d+$/.test(value)) return { ok: false };

  const score = Number(value);
  if (!Number.isInteger(score) || score < 0 || score > 100) return { ok: false };
  return { ok: true, value: score };
}

async function readInput(req: Request): Promise<Record<string, string>> {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  if (json) {
    const body = (await req.json()) as Record<string, unknown>;
    return {
      journalDateId: String(body.journalDateId ?? ""),
      studentId: String(body.studentId ?? ""),
      attendance: String(body.attendance ?? ""),
      lessonId: String(body.lessonId ?? ""),
      theoryScore: String(body.theoryScore ?? ""),
      practicalScore: String(body.practicalScore ?? ""),
      redirectTo: String(body.redirectTo ?? ""),
    };
  }

  const form = await req.formData();
  return {
    journalDateId: String(form.get("journalDateId") ?? ""),
    studentId: String(form.get("studentId") ?? ""),
    attendance: String(form.get("attendance") ?? ""),
    lessonId: String(form.get("lessonId") ?? ""),
    theoryScore: String(form.get("theoryScore") ?? ""),
    practicalScore: String(form.get("practicalScore") ?? ""),
    redirectTo: String(form.get("redirectTo") ?? ""),
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || (session.role !== "ADMIN" && session.role !== "CURATOR")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const asJson = isJson(req);
  const input = await readInput(req);

  const journalDateId = input.journalDateId.trim();
  const studentId = input.studentId.trim();
  const attendance = parseJournalAttendance(input.attendance);
  const lessonId = input.lessonId.trim() || null;
  const theoryParsed = parseScoreField(input.theoryScore);
  const practicalParsed = parseScoreField(input.practicalScore);

  if (!journalDateId || !studentId || !attendance) {
    const error = "Sana, student va davomat majburiy";
    if (asJson) return NextResponse.json({ ok: false, error }, { status: 400 });
    return redirectTo(req, getRedirectPath(input.redirectTo, session.role), error, true);
  }

  if (!theoryParsed.ok || !practicalParsed.ok) {
    const error = "Ball 0..100 oralig'ida bo'lishi kerak";
    if (asJson) return NextResponse.json({ ok: false, error }, { status: 400 });
    return redirectTo(req, getRedirectPath(input.redirectTo, session.role), error, true);
  }

  const journalDate = await prisma.groupJournalDate.findUnique({
    where: { id: journalDateId },
    select: {
      id: true,
      groupId: true,
      journalDate: true,
    },
  });

  if (!journalDate) {
    const error = "Sana topilmadi";
    if (asJson) return NextResponse.json({ ok: false, error }, { status: 404 });
    return redirectTo(req, getRedirectPath(input.redirectTo, session.role), error, true);
  }

  const redirectPath = getRedirectPath(input.redirectTo, session.role, journalDate.groupId);

  const allowed = await canAccessGroupForJournal(session, journalDate.groupId);
  if (!allowed) {
    const error = "Bu guruhga dostup yo'q";
    if (asJson) return NextResponse.json({ ok: false, error }, { status: 403 });
    return redirectTo(req, redirectPath, error, true);
  }

  const today = startOfTodayUtc();
  if (journalDate.journalDate.getTime() < today.getTime()) {
    const error = "Bu sana o'tib ketgan, ma'lumotni tahrirlab bo'lmaydi";
    if (asJson) return NextResponse.json({ ok: false, error }, { status: 400 });
    return redirectTo(req, redirectPath, error, true);
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      groupId: journalDate.groupId,
      studentId,
      status: {
        in: [EnrollmentStatus.TRIAL, EnrollmentStatus.ACTIVE],
      },
    },
    select: { id: true },
  });

  if (!enrollment) {
    const error = "Bu student guruhda SINOV/AKTIV holatda emas";
    if (asJson) return NextResponse.json({ ok: false, error }, { status: 400 });
    return redirectTo(req, redirectPath, error, true);
  }

  if (lessonId) {
    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { id: true } });
    if (!lesson) {
      const error = "Dars topilmadi";
      if (asJson) return NextResponse.json({ ok: false, error }, { status: 400 });
      return redirectTo(req, redirectPath, error, true);
    }
  }

  try {
    const existing = await prisma.groupJournalEntry.findUnique({
      where: {
        journalDateId_studentId: {
          journalDateId,
          studentId,
        },
      },
      select: { id: true },
    });

    const upserted = await prisma.groupJournalEntry.upsert({
      where: {
        journalDateId_studentId: {
          journalDateId,
          studentId,
        },
      },
      update: {
        attendance,
        lessonId,
        theoryScore: theoryParsed.value,
        practicalScore: practicalParsed.value,
        updatedById: session.userId,
      },
      create: {
        journalDateId,
        studentId,
        attendance,
        lessonId,
        theoryScore: theoryParsed.value,
        practicalScore: practicalParsed.value,
        createdById: session.userId,
        updatedById: session.userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: existing ? "UPDATE" : "CREATE",
        entity: "GroupJournalEntry",
        entityId: upserted.id,
        payload: {
          groupId: journalDate.groupId,
          journalDateId,
          studentId,
          attendance,
          lessonId,
          theoryScore: theoryParsed.value,
          practicalScore: practicalParsed.value,
        },
      },
    });

    const studentInfo = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        fullName: true,
        phone: true,
        parentPhone: true,
        user: {
          select: {
            telegramUserId: true,
          },
        },
      },
    });

    const lessonInfo = lessonId
      ? await prisma.lesson.findUnique({
          where: { id: lessonId },
          include: {
            book: {
              select: {
                title: true,
              },
            },
          },
        })
      : null;

    const parentContact = studentInfo?.parentPhone
      ? await prisma.parentContact.findFirst({
          where: {
            OR: [
              { phone: studentInfo.parentPhone },
              { phone: studentInfo.parentPhone.replace(/^\+/, "") },
            ],
          },
          select: { telegramUserId: true },
        })
      : null;

    const header = "📣 Bugungi dars natijasi";
    const body = [
      `👤 O'quvchi: ${studentInfo?.fullName ?? "-"}`,
      `📅 Sana: ${formatUzDateOnly(journalDate.journalDate)}`,
      `📍 Davomat: ${formatJournalAttendance(attendance)}`,
      `📘 Dars: ${lessonInfo ? `${lessonInfo.book.title} | ${lessonInfo.lessonNumber}-dars` : "-"}`,
      `🧠 Nazariy: ${theoryParsed.value ?? "-"}%`,
      `🛠️ Amaliy: ${practicalParsed.value ?? "-"}%`,
    ].join("\n");

    const notificationText = `${header}\n\n${body}`;

    const studentTelegramId = studentInfo?.user?.telegramUserId ?? null;
    if (studentTelegramId) {
      await sendTelegramMessage(studentTelegramId, notificationText, {
        replyMarkup: studentReplyKeyboard(),
      });
    }

    const parentTelegramId = parentContact?.telegramUserId ?? null;
    if (parentTelegramId) {
      await sendTelegramMessage(parentTelegramId, notificationText, {
        replyMarkup: parentReplyKeyboard(),
      });
    }

    if (asJson) return NextResponse.json({ ok: true, entry: upserted });
    return redirectTo(req, redirectPath, "Davomat va baho saqlandi");
  } catch (error) {
    console.error("GROUP_JOURNAL_ENTRY_UPSERT_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Saqlashda xatolik" }, { status: 500 });
    return redirectTo(req, redirectPath, "Saqlashda xatolik", true);
  }
}

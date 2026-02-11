import "dotenv/config";
import { Bot, InputFile, Keyboard, webhookCallback } from "grammy";
import { prisma } from "@km/db";
import { parseAnswerText } from "@km/shared";
import { EnrollmentStatus, GroupCatalogStatus, Role } from "@prisma/client";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";

type ActorType = "STUDENT" | "PARENT";

type SessionState = {
  awaitingPhone: boolean;
  awaitingAppeal: boolean;
  activeTestId?: string;
  activeWindowId?: string;
  activeGroupLink?: string | null;
  sentTestMessageIds: number[];
};

type StudentActor = {
  type: "STUDENT";
  userId: string;
  student: {
    id: string;
    fullName: string;
    phone: string;
    parentPhone: string | null;
  };
};

type ParentActor = {
  type: "PARENT";
  student: {
    id: string;
    userId: string | null;
    fullName: string;
    phone: string;
    parentPhone: string | null;
  };
};

type Actor = StudentActor | ParentActor;

type PaymentRow = {
  id: string;
  amountRequired: number;
  amountPaid: number;
  discount: number;
  month: string;
  periodEnd: Date | null;
  groupId: string | null;
  group: {
    code: string;
    status: GroupCatalogStatus;
    priceMonthly: number;
  } | null;
};

const STUDENT_BTN_TEST = "📝 Test ishlash";
const STUDENT_BTN_PAY = "💳 To'lov qilish";
const STUDENT_BTN_RESULTS = "📊 Natijalarim";
const STUDENT_BTN_APPEAL = "✍️ E'tiroz bildirish";

const PARENT_BTN_RESULTS = "📘 O'quvchi natijalari";
const PARENT_BTN_DEBT = "💸 Qarzdorlik";
const PARENT_BTN_APPEAL = "✍️ E'tiroz bildirish";

const REJECT_TEXT = "Siz bizning onlayn kurslarimizda o'qimaysiz. Batafsil @ceo97 administratorimizdan so'rang.";

const state = new Map<number, SessionState>();
const pendingGroupLeaveTimers = new Map<string, NodeJS.Timeout>();
const pendingJoinByUser = new Map<number, { windowId: string; expiresAt: number }>();
const windowChatTargets = new Map<string, string | number>();

const botToken = process.env.BOT_TOKEN;
const webBaseUrl = process.env.WEB_BASE_URL;
const webhookPath = process.env.BOT_WEBHOOK_PATH;
const webhookUrl = process.env.BOT_WEBHOOK_URL;
const port = Number(process.env.BOT_PORT ?? 4000);
const isProduction = process.env.NODE_ENV === "production";
const allowPartialSubmissions = process.env.ALLOW_PARTIAL_SUBMISSIONS === "true";

if (!botToken || !webBaseUrl) {
  throw new Error("BOT_TOKEN va WEB_BASE_URL .env da bo'lishi shart");
}

const bot = new Bot(botToken);

const phoneKeyboard = new Keyboard().requestContact("📱 Telefon raqamni yuborish").resized();
const studentMenuKeyboard = new Keyboard()
  .text(STUDENT_BTN_TEST)
  .text(STUDENT_BTN_PAY)
  .row()
  .text(STUDENT_BTN_RESULTS)
  .text(STUDENT_BTN_APPEAL)
  .resized();

const parentMenuKeyboard = new Keyboard()
  .text(PARENT_BTN_RESULTS)
  .text(PARENT_BTN_DEBT)
  .row()
  .text(PARENT_BTN_APPEAL)
  .resized();

const studentButtons = new Set([STUDENT_BTN_TEST, STUDENT_BTN_PAY, STUDENT_BTN_RESULTS, STUDENT_BTN_APPEAL]);
const parentButtons = new Set([PARENT_BTN_RESULTS, PARENT_BTN_DEBT, PARENT_BTN_APPEAL]);

if (!isProduction) {
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      console.log("UPDATE", {
        updateId: ctx.update.update_id,
        fromId: ctx.from.id,
        text: ctx.message?.text ?? null,
      });
    }
    await next();
  });
}

function getSessionState(fromId: number): SessionState {
  const existing = state.get(fromId);
  if (existing) return existing;

  const initial: SessionState = {
    awaitingPhone: true,
    awaitingAppeal: false,
    activeWindowId: undefined,
    activeGroupLink: undefined,
    sentTestMessageIds: [],
  };
  state.set(fromId, initial);
  return initial;
}

function normalizeUzPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;
  if (raw.startsWith("+")) return `+${digits}`;
  return `+${digits}`;
}

function phoneVariants(raw: string): string[] {
  const normalized = normalizeUzPhone(raw);
  if (!normalized) return [];

  const variants = new Set<string>();
  variants.add(normalized);
  variants.add(normalized.replace(/^\+/, ""));
  return Array.from(variants);
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("uz-UZ", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}

function formatDateOnly(value: Date): string {
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${d}.${m}.${y}`;
}

function formatAttendance(attendance: "PRESENT" | "ABSENT" | "EXCUSED"): string {
  if (attendance === "PRESENT") return "Keldi ✅";
  if (attendance === "ABSENT") return "Kelmadi ❌";
  return "Sababli 🟡";
}

function resolveImageUrl(imageUrl: string) {
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  if (imageUrl.startsWith("/")) return `${webBaseUrl}${imageUrl}`;
  return `${webBaseUrl}/${imageUrl}`;
}

function resolveLocalImagePath(imageUrl: string) {
  const raw = imageUrl.trim();
  let relative = raw.replace(/^\/+/, "");

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      relative = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }

  if (!relative) return null;

  const candidate1 = path.resolve(process.cwd(), "../web/public", relative);
  const candidate2 = path.resolve(process.cwd(), "apps/web/public", relative);

  if (existsSync(candidate1)) return candidate1;
  if (existsSync(candidate2)) return candidate2;

  return null;
}

async function sendTestImage(
  ctx: { replyWithPhoto: (photo: string | InputFile, other?: Record<string, unknown>) => Promise<unknown> },
  imageUrl: string,
): Promise<number | null> {
  const localPath = resolveLocalImagePath(imageUrl);
  const sent = localPath
    ? await ctx.replyWithPhoto(new InputFile(localPath), { protect_content: true })
    : await ctx.replyWithPhoto(resolveImageUrl(imageUrl), { protect_content: true });

  const maybeMessage = sent as { message_id?: number };
  return typeof maybeMessage.message_id === "number" ? maybeMessage.message_id : null;
}

function normalizeTelegramGroupLink(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("t.me/") || value.startsWith("telegram.me/")) return `https://${value}`;
  if (value.startsWith("@")) return `https://t.me/${value.slice(1)}`;
  return value;
}

function extractChatIdFromGroupLink(link: string): string | number | null {
  const normalized = normalizeTelegramGroupLink(link);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/^\/+/, "");
    if (!path) return null;

    const firstSegment = path.split("/")[0] ?? "";
    if (!firstSegment || firstSegment.startsWith("+") || firstSegment === "joinchat") return null;

    return `@${firstSegment}`;
  } catch {
    return null;
  }
}

function isPrivateInviteLink(link: string): boolean {
  const normalized = normalizeTelegramGroupLink(link);
  return /^https?:\/\/(t\.me|telegram\.me)\/(\+|joinchat\/)[a-zA-Z0-9_-]{8,}$/i.test(normalized);
}

async function createSingleUseInviteLink(groupLink: string, windowId: string): Promise<{
  inviteLink: string;
  chatId: string | number;
} | null> {
  const chatId = extractChatIdFromGroupLink(groupLink);
  if (!chatId) return null;

  const expireAtUnix = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const invite = await bot.api.createChatInviteLink(chatId, {
    name: `test-${windowId.slice(0, 8)}`,
    member_limit: 1,
    expire_date: expireAtUnix,
  });

  return {
    inviteLink: invite.invite_link,
    chatId,
  };
}

async function kickStudentFromGroupByLink(groupLink: string, telegramUserId: number): Promise<boolean> {
  const chatId = extractChatIdFromGroupLink(groupLink);
  if (!chatId) return false;
  return kickStudentFromChat(chatId, telegramUserId);
}

async function kickStudentFromChat(chatId: string | number, telegramUserId: number): Promise<boolean> {
  try {
    await bot.api.banChatMember(chatId, telegramUserId, { revoke_messages: false });
    await bot.api.unbanChatMember(chatId, telegramUserId, { only_if_banned: true });
    return true;
  } catch (error) {
    console.error("GROUP_KICK_ERROR", { chatId, telegramUserId, error });
    return false;
  }
}

async function kickStudentFromTestGroup(
  windowId: string | undefined,
  groupLink: string,
  telegramUserId: number,
): Promise<boolean> {
  const target = windowId ? windowChatTargets.get(windowId) : undefined;
  if (target !== undefined) {
    return kickStudentFromChat(target, telegramUserId);
  }

  return kickStudentFromGroupByLink(groupLink, telegramUserId);
}

function registerPendingJoin(userTelegramId: number, windowId: string, delayMs: number) {
  pendingJoinByUser.set(userTelegramId, {
    windowId,
    expiresAt: Date.now() + delayMs,
  });
}

function clearPendingJoin(userTelegramId: number, windowId?: string) {
  const pending = pendingJoinByUser.get(userTelegramId);
  if (!pending) return;
  if (windowId && pending.windowId !== windowId) return;
  pendingJoinByUser.delete(userTelegramId);
}

function clearWindowChatTarget(windowId?: string) {
  if (!windowId) return;
  windowChatTargets.delete(windowId);
}

function clearPendingGroupAccess(userTelegramId: number, windowId?: string) {
  clearPendingJoin(userTelegramId, windowId);
  if (windowId) {
    clearPendingGroupLeave(windowId);
    clearWindowChatTarget(windowId);
  }
}

function scheduleGroupLeave(windowId: string, groupLink: string, telegramUserId: number, delayMs: number) {
  clearPendingGroupLeave(windowId);
  const timer = setTimeout(async () => {
    try {
      await kickStudentFromTestGroup(windowId, groupLink, telegramUserId);
    } finally {
      pendingGroupLeaveTimers.delete(windowId);
      pendingJoinByUser.delete(telegramUserId);
      windowChatTargets.delete(windowId);
    }
  }, delayMs);
  pendingGroupLeaveTimers.set(windowId, timer);
}

function isJoinedChatMemberStatus(status: string): boolean {
  return status === "member" || status === "administrator" || status === "creator" || status === "restricted";
}

function handlePotentialGroupJoin(chatId: number, userTelegramId: number, status: string) {
  if (!isJoinedChatMemberStatus(status)) return;

  const pending = pendingJoinByUser.get(userTelegramId);
  if (!pending) return;
  if (pending.expiresAt < Date.now()) {
    pendingJoinByUser.delete(userTelegramId);
    return;
  }

  windowChatTargets.set(pending.windowId, chatId);
  pendingJoinByUser.delete(userTelegramId);
  scheduleGroupLeave(pending.windowId, "", userTelegramId, 2 * 60 * 60 * 1000);
}

async function removeStudentFromTestGroup(
  windowId: string | undefined,
  groupLink: string | null | undefined,
  telegramUserId: number,
): Promise<boolean> {
  if (!groupLink) return false;
  return kickStudentFromTestGroup(windowId, groupLink, telegramUserId);
}

function clearPendingGroupLeave(windowId: string) {
  const timer = pendingGroupLeaveTimers.get(windowId);
  if (!timer) return;
  clearTimeout(timer);
  pendingGroupLeaveTimers.delete(windowId);
}

async function ensureStudentUserForBot(student: {
  id: string;
  userId: string | null;
  phone: string;
  status: string;
}) {
  return prisma.$transaction(async (tx) => {
    const variants = phoneVariants(student.phone);

    const existingUser = student.userId
      ? await tx.user.findUnique({ where: { id: student.userId } })
      : await tx.user.findFirst({
          where: {
            OR: variants.map((phone) => ({ phone })),
          },
        });

    if (existingUser && existingUser.role !== Role.STUDENT) {
      throw new Error("PHONE_USED_BY_OTHER_ROLE");
    }

    const user = existingUser
      ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            role: Role.STUDENT,
            phone: student.phone,
            isActive: student.status === "ACTIVE",
          },
        })
      : await tx.user.create({
          data: {
            role: Role.STUDENT,
            phone: student.phone,
            isActive: student.status === "ACTIVE",
          },
        });

    if (!student.userId || student.userId !== user.id) {
      await tx.student.update({
        where: { id: student.id },
        data: { userId: user.id },
      });
    }

    return user;
  });
}

async function findEligibleStudentByPhone(phone: string): Promise<{
  student: {
    id: string;
    userId: string | null;
    fullName: string;
    phone: string;
    parentPhone: string | null;
    status: string;
  };
  personType: ActorType;
} | null> {
  const variants = phoneVariants(phone);
  if (variants.length === 0) return null;

  const eligibilityFilter = {
    status: "ACTIVE" as const,
    enrollments: {
      some: {
        status: {
          in: [EnrollmentStatus.TRIAL, EnrollmentStatus.ACTIVE],
        },
        group: {
          status: {
            in: [GroupCatalogStatus.REJADA, GroupCatalogStatus.OCHIQ, GroupCatalogStatus.BOSHLANGAN],
          },
        },
      },
    },
  };

  const byStudentPhone = await prisma.student.findFirst({
    where: {
      ...eligibilityFilter,
      OR: variants.map((value) => ({ phone: value })),
    },
    select: {
      id: true,
      userId: true,
      fullName: true,
      phone: true,
      parentPhone: true,
      status: true,
    },
  });

  if (byStudentPhone) {
    return { student: byStudentPhone, personType: "STUDENT" };
  }

  const byParentPhone = await prisma.student.findFirst({
    where: {
      ...eligibilityFilter,
      OR: variants.map((value) => ({ parentPhone: value })),
    },
    select: {
      id: true,
      userId: true,
      fullName: true,
      phone: true,
      parentPhone: true,
      status: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!byParentPhone) return null;
  return { student: byParentPhone, personType: "PARENT" };
}

async function resolveActorByTelegramUserId(telegramUserId: number): Promise<Actor | null> {
  const tg = String(telegramUserId);

  const studentUser = await prisma.user.findFirst({
    where: {
      telegramUserId: tg,
      role: Role.STUDENT,
      isActive: true,
    },
    select: {
      id: true,
      studentProfile: {
        where: {
          status: "ACTIVE",
          enrollments: {
            some: {
              status: {
                in: [EnrollmentStatus.TRIAL, EnrollmentStatus.ACTIVE],
              },
              group: {
                status: {
                  in: [GroupCatalogStatus.REJADA, GroupCatalogStatus.OCHIQ, GroupCatalogStatus.BOSHLANGAN],
                },
              },
            },
          },
        },
        select: {
          id: true,
          fullName: true,
          phone: true,
          parentPhone: true,
        },
      },
    },
  });

  if (studentUser?.studentProfile) {
    return {
      type: "STUDENT",
      userId: studentUser.id,
      student: studentUser.studentProfile,
    };
  }

  const parentContact = await prisma.parentContact.findUnique({
    where: { telegramUserId: tg },
    select: { phone: true },
  });

  if (!parentContact) return null;

  const parentPhoneOr = phoneVariants(parentContact.phone);
  if (parentPhoneOr.length === 0) return null;

  const student = await prisma.student.findFirst({
    where: {
      status: "ACTIVE",
      OR: parentPhoneOr.map((value) => ({ parentPhone: value })),
      enrollments: {
        some: {
          status: {
            in: [EnrollmentStatus.TRIAL, EnrollmentStatus.ACTIVE],
          },
          group: {
            status: {
              in: [GroupCatalogStatus.REJADA, GroupCatalogStatus.OCHIQ, GroupCatalogStatus.BOSHLANGAN],
            },
          },
        },
      },
    },
    select: {
      id: true,
      userId: true,
      fullName: true,
      phone: true,
      parentPhone: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!student) return null;

  return {
    type: "PARENT",
    student,
  };
}

async function getActiveWindow(studentUserId: string) {
  const now = new Date();
  return prisma.accessWindow.findFirst({
    where: {
      studentId: studentUserId,
      isActive: true,
      openFrom: { lte: now },
      openTo: { gte: now },
      test: { isActive: true },
    },
    include: {
      test: {
        include: {
          lesson: {
            include: {
              book: true,
            },
          },
          images: { orderBy: { pageNumber: "asc" } },
        },
      },
    },
    orderBy: { openFrom: "desc" },
  });
}

function addMonthsKeepingDay(date: Date, months: number): Date {
  const source = new Date(date);
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const day = source.getUTCDate();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;

  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(Date.UTC(targetYear, normalizedMonth, targetDay));
}

function baseDebt(payment: PaymentRow): number {
  return Math.max(0, payment.amountRequired - payment.discount - payment.amountPaid);
}

function extraDebtForOpenGroup(payment: PaymentRow, now: Date): number {
  if (!payment.group || payment.group.status !== GroupCatalogStatus.OCHIQ || !payment.periodEnd) return 0;

  const end = new Date(Date.UTC(payment.periodEnd.getUTCFullYear(), payment.periodEnd.getUTCMonth(), payment.periodEnd.getUTCDate()));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (today <= end) return 0;

  let periods = 0;
  let cursor = new Date(end);
  while (cursor <= today) {
    periods += 1;
    cursor = addMonthsKeepingDay(end, periods);
  }

  return periods * payment.group.priceMonthly;
}

async function getStudentDebtSummary(studentRegistryId: string) {
  const rows = await prisma.payment.findMany({
    where: {
      studentId: studentRegistryId,
      isDeleted: false,
    },
    include: {
      group: {
        select: {
          code: true,
          status: true,
          priceMonthly: true,
        },
      },
    },
    orderBy: [{ month: "desc" }, { paidAt: "desc" }],
    take: 500,
  });

  const now = new Date();

  const latestByGroup = new Map<string, PaymentRow>();
  let totalBase = 0;
  for (const row of rows) {
    totalBase += baseDebt(row);

    if (!row.groupId || !row.periodEnd) continue;
    const prev = latestByGroup.get(row.groupId);
    if (!prev || (prev.periodEnd && prev.periodEnd.getTime() < row.periodEnd.getTime())) {
      latestByGroup.set(row.groupId, row);
    }
  }

  let totalExtra = 0;
  for (const latest of latestByGroup.values()) {
    totalExtra += extraDebtForOpenGroup(latest, now);
  }

  const totalDebt = totalBase + totalExtra;

  const topRows = rows.slice(0, 10).map((row) => {
    const net = Math.max(0, row.amountRequired - row.discount);
    const debt = baseDebt(row);
    return {
      month: row.month,
      groupCode: row.group?.code ?? "-",
      net,
      paid: row.amountPaid,
      debt,
      status: row.status,
    };
  });

  return {
    totalDebt,
    totalBase,
    totalExtra,
    topRows,
  };
}

async function sendStudentHome(ctx: { reply: (...args: any[]) => Promise<unknown> }, actor: StudentActor) {
  await ctx.reply(`Kelajakmediklari botiga xush kelibsiz, ${actor.student.fullName}!`, {
    reply_markup: studentMenuKeyboard,
  });
}

async function sendParentHome(ctx: { reply: (...args: any[]) => Promise<unknown> }, actor: ParentActor) {
  await ctx.reply(`Kelajakmediklari botiga xush kelibsiz!\nFarzandingiz: ${actor.student.fullName}`, {
    reply_markup: parentMenuKeyboard,
  });
}

async function showStudentMonthlyResults(ctx: { reply: (...args: any[]) => Promise<unknown> }, actor: StudentActor) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

  const submissions = await prisma.submission.findMany({
    where: {
      studentId: actor.userId,
      createdAt: {
        gte: start,
        lt: end,
      },
    },
    include: {
      test: {
        include: {
          lesson: {
            include: {
              book: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (!submissions.length) {
    await ctx.reply("Bu oy uchun topshirilgan test natijalari topilmadi.", {
      reply_markup: studentMenuKeyboard,
    });
    return;
  }

  const monthText = `${String(now.getMonth() + 1).padStart(2, "0")}.${now.getFullYear()}`;
  const lines = submissions.map((item, idx) => {
    return `${idx + 1}) ${formatDate(item.createdAt)}\n${item.test.lesson.book.title} | ${item.test.lesson.lessonNumber}-dars | ${item.score}/${item.test.totalQuestions}`;
  });

  await ctx.reply(`📊 Joriy oy natijalari (${monthText})\n\n${lines.join("\n\n")}`, {
    reply_markup: studentMenuKeyboard,
  });
}

async function showStudentPaymentInfo(ctx: { reply: (...args: any[]) => Promise<unknown> }, actor: StudentActor) {
  const debt = await getStudentDebtSummary(actor.student.id);

  const lines = debt.topRows.map(
    (row, idx) =>
      `${idx + 1}) ${row.month} | ${row.groupCode}\nTalab: ${row.net.toLocaleString("uz-UZ")} | To'langan: ${row.paid.toLocaleString("uz-UZ")} | Qarz: ${row.debt.toLocaleString("uz-UZ")}`,
  );

  const text =
    `💳 To'lov holati\n\n` +
    `Jami qarzdorlik: ${debt.totalDebt.toLocaleString("uz-UZ")} so'm\n` +
    (debt.totalExtra > 0 ? `Shundan kechikkan davrlar uchun: ${debt.totalExtra.toLocaleString("uz-UZ")} so'm\n` : "") +
    `\nTo'lov qilish uchun administrator: @ceo97\n\n` +
    (lines.length ? `Yaqin yozuvlar:\n${lines.join("\n\n")}` : "To'lov yozuvlari topilmadi.");

  await ctx.reply(text, { reply_markup: studentMenuKeyboard });
}

async function showParentDebt(ctx: { reply: (...args: any[]) => Promise<unknown> }, actor: ParentActor) {
  const debt = await getStudentDebtSummary(actor.student.id);
  const text = debt.totalDebt > 0
    ? `💸 Farzandingiz uchun qarzdorlik mavjud: ${debt.totalDebt.toLocaleString("uz-UZ")} so'm\nBatafsil uchun administrator: @ceo97`
    : "✅ Hozircha qarzdorlik mavjud emas.";

  await ctx.reply(text, { reply_markup: parentMenuKeyboard });
}

async function showParentResults(ctx: { reply: (...args: any[]) => Promise<unknown> }, actor: ParentActor) {
  const testResults = actor.student.userId
    ? await prisma.submission.findMany({
        where: { studentId: actor.student.userId },
        include: {
          test: {
            include: {
              lesson: {
                include: {
                  book: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      })
    : [];

  const journalRows = await prisma.groupJournalEntry.findMany({
    where: { studentId: actor.student.id },
    include: {
      journalDate: {
        include: {
          group: {
            select: {
              code: true,
            },
          },
        },
      },
      lesson: {
        include: {
          book: true,
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 10,
  });

  const testText = testResults.length
    ? testResults
        .map(
          (item, idx) =>
            `${idx + 1}) ${formatDate(item.createdAt)}\n${item.test.lesson.book.title} | ${item.test.lesson.lessonNumber}-dars | ${item.score}/${item.test.totalQuestions}`,
        )
        .join("\n\n")
    : "Test natijalari topilmadi.";

  const journalText = journalRows.length
    ? journalRows
        .map((item, idx) => {
          const lesson = item.lesson
            ? `${item.lesson.book.title} | ${item.lesson.lessonNumber}-dars`
            : "-";
          return `${idx + 1}) ${formatDateOnly(item.journalDate.journalDate)} | ${item.journalDate.group.code}\n${formatAttendance(item.attendance)}\nDars: ${lesson}\nNazariy: ${item.theoryScore ?? "-"}% | Amaliy: ${item.practicalScore ?? "-"}%`;
        })
        .join("\n\n")
    : "Davomat/baholash natijalari topilmadi.";

  await ctx.reply(`📘 Oxirgi 10 ta test natija\n\n${testText}`, { reply_markup: parentMenuKeyboard });
  await ctx.reply(`🧾 Oxirgi 10 ta davomat va baholash\n\n${journalText}`, { reply_markup: parentMenuKeyboard });
}

async function createAppealFromStudent(
  ctx: { from: { id: number }; reply: (...args: any[]) => Promise<unknown> },
  actor: StudentActor,
  text: string,
) {
  const trimmed = text.trim();
  if (trimmed.length < 5) {
    await ctx.reply("E'tiroz matni juda qisqa. Iltimos, batafsil yozing.", {
      reply_markup: studentMenuKeyboard,
    });
    return false;
  }

  await prisma.appeal.create({
    data: {
      studentId: actor.student.id,
      senderType: "STUDENT",
      senderTelegramUserId: String(ctx.from.id),
      senderPhone: actor.student.phone,
      text: trimmed,
    },
  });

  await ctx.reply("E'tirozingiz qabul qilindi ✅\nLoyiha rahbari Husniddin Ergashev ko'rib chiqadi.", {
    reply_markup: studentMenuKeyboard,
  });
  return true;
}

async function createAppealFromParent(
  ctx: { from: { id: number }; reply: (...args: any[]) => Promise<unknown> },
  actor: ParentActor,
  text: string,
) {
  const trimmed = text.trim();
  if (trimmed.length < 5) {
    await ctx.reply("Xabar juda qisqa. Iltimos, batafsil yozing.", {
      reply_markup: parentMenuKeyboard,
    });
    return false;
  }

  await prisma.appeal.create({
    data: {
      studentId: actor.student.id,
      senderType: "PARENT",
      senderTelegramUserId: String(ctx.from.id),
      senderPhone: actor.student.parentPhone,
      text: trimmed,
    },
  });

  await ctx.reply("E'tirozingiz qabul qilindi ✅\nLoyiha rahbari Husniddin Ergashev ko'rib chiqadi.", {
    reply_markup: parentMenuKeyboard,
  });
  return true;
}

bot.command("start", async (ctx) => {
  if (!ctx.from) return;

  const actor = await resolveActorByTelegramUserId(ctx.from.id);
  const session = getSessionState(ctx.from.id);

  if (!actor) {
    clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
    session.awaitingPhone = true;
    session.awaitingAppeal = false;
    session.activeTestId = undefined;
    session.activeWindowId = undefined;
    session.activeGroupLink = undefined;
    session.sentTestMessageIds = [];
    state.set(ctx.from.id, session);

    await ctx.reply(
      "Kelajakmediklari botiga xush kelibsiz. Telefon raqamingizni faqat pastdagi tugma orqali yuboring.",
      { reply_markup: phoneKeyboard },
    );
    return;
  }

  clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
  session.awaitingPhone = false;
  session.awaitingAppeal = false;
  session.activeTestId = undefined;
  session.activeWindowId = undefined;
  session.activeGroupLink = undefined;
  session.sentTestMessageIds = [];
  state.set(ctx.from.id, session);

  if (actor.type === "STUDENT") {
    await sendStudentHome(ctx, actor);
    return;
  }

  await sendParentHome(ctx, actor);
});

bot.command("ping", async (ctx) => {
  await ctx.reply("Bot ishlayapti ✅");
});

bot.on("chat_member", async (ctx) => {
  const payload = ctx.update.chat_member;
  if (!payload) return;
  handlePotentialGroupJoin(payload.chat.id, payload.new_chat_member.user.id, payload.new_chat_member.status);
});

bot.on("message:contact", async (ctx) => {
  if (!ctx.from) return;

  if (!ctx.message.contact.user_id || ctx.message.contact.user_id !== ctx.from.id) {
    await ctx.reply("Iltimos, o'zingizning raqamingizni yuboring.");
    return;
  }

  const session = getSessionState(ctx.from.id);

  const found = await findEligibleStudentByPhone(ctx.message.contact.phone_number);
  if (!found) {
    await ctx.reply(REJECT_TEXT, {
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  try {
    if (found.personType === "STUDENT") {
      const user = await ensureStudentUserForBot(found.student);
      await prisma.user.update({
        where: { id: user.id },
        data: { telegramUserId: String(ctx.from.id), isActive: true },
      });

      session.awaitingPhone = false;
      session.awaitingAppeal = false;
      clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
      session.activeTestId = undefined;
      session.activeWindowId = undefined;
      session.activeGroupLink = undefined;
      session.sentTestMessageIds = [];
      state.set(ctx.from.id, session);

      await sendStudentHome(ctx, {
        type: "STUDENT",
        userId: user.id,
        student: {
          id: found.student.id,
          fullName: found.student.fullName,
          phone: found.student.phone,
          parentPhone: found.student.parentPhone,
        },
      });
      return;
    }

    const parentPhone = found.student.parentPhone ? normalizeUzPhone(found.student.parentPhone) : "";
    if (!parentPhone) {
      await ctx.reply("Ota-ona raqami topilmadi. Administratorga murojaat qiling.");
      return;
    }

    await prisma.$transaction(async (tx) => {
      const byPhone = await tx.parentContact.findUnique({
        where: { phone: parentPhone },
      });

      if (byPhone) {
        await tx.parentContact.update({
          where: { id: byPhone.id },
          data: {
            telegramUserId: String(ctx.from.id),
          },
        });
      } else {
        const byTelegram = await tx.parentContact.findUnique({
          where: { telegramUserId: String(ctx.from.id) },
        });

        if (byTelegram) {
          await tx.parentContact.update({
            where: { id: byTelegram.id },
            data: {
              phone: parentPhone,
            },
          });
        } else {
          await tx.parentContact.create({
            data: {
              phone: parentPhone,
              telegramUserId: String(ctx.from.id),
            },
          });
        }
      }
    });

    session.awaitingPhone = false;
    session.awaitingAppeal = false;
    clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
    session.activeTestId = undefined;
    session.activeWindowId = undefined;
    session.activeGroupLink = undefined;
    session.sentTestMessageIds = [];
    state.set(ctx.from.id, session);

    await sendParentHome(ctx, {
      type: "PARENT",
      student: {
        id: found.student.id,
        userId: found.student.userId,
        fullName: found.student.fullName,
        phone: found.student.phone,
        parentPhone: found.student.parentPhone,
      },
    });
  } catch (error) {
    console.error("BOT_CONTACT_LINK_ERROR", error);
    await ctx.reply("Raqamni bog'lashda xatolik bo'ldi. Iltimos, qayta urinib ko'ring.");
  }
});

bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;

  const text = ctx.message.text.trim();
  const session = getSessionState(ctx.from.id);
  const actor = await resolveActorByTelegramUserId(ctx.from.id);

  if (!actor) {
    clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
    session.awaitingPhone = true;
    session.awaitingAppeal = false;
    session.activeTestId = undefined;
    session.activeWindowId = undefined;
    session.activeGroupLink = undefined;
    session.sentTestMessageIds = [];
    state.set(ctx.from.id, session);
    await ctx.reply("Telefon raqamni qo'lda yozmang. Pastdagi tugma orqali yuboring.", {
      reply_markup: phoneKeyboard,
    });
    return;
  }

  if (session.awaitingPhone) {
    session.awaitingPhone = false;
    state.set(ctx.from.id, session);
  }

  if (actor.type === "STUDENT" && session.awaitingAppeal && !studentButtons.has(text)) {
    const saved = await createAppealFromStudent(ctx, actor, text);
    if (saved) {
      session.awaitingAppeal = false;
      state.set(ctx.from.id, session);
    }
    return;
  }

  if (actor.type === "STUDENT") {
    if (text === STUDENT_BTN_APPEAL) {
      session.awaitingAppeal = true;
      state.set(ctx.from.id, session);
      await ctx.reply(
        "E'tirozingizni yozishingiz mumkin. Bu xabar to'g'ridan-to'g'ri loyiha rahbari Husniddin Ergashevga yuboriladi.",
        { reply_markup: studentMenuKeyboard },
      );
      return;
    }

    if (text === STUDENT_BTN_RESULTS) {
      session.awaitingAppeal = false;
      state.set(ctx.from.id, session);
      await showStudentMonthlyResults(ctx, actor);
      return;
    }

    if (text === STUDENT_BTN_PAY) {
      session.awaitingAppeal = false;
      state.set(ctx.from.id, session);
      await showStudentPaymentInfo(ctx, actor);
      return;
    }

    if (text === STUDENT_BTN_TEST) {
      session.awaitingAppeal = false;
      state.set(ctx.from.id, session);

      const activeWindow = await getActiveWindow(actor.userId);
      if (!activeWindow) {
        await ctx.reply("Hozircha aktiv test yo'q.", { reply_markup: studentMenuKeyboard });
        return;
      }

      session.activeTestId = activeWindow.testId;
      session.activeWindowId = activeWindow.id;
      session.sentTestMessageIds = [];
      state.set(ctx.from.id, session);

      if (activeWindow.openedAt) {
        await ctx.reply(
          `Sizga test allaqachon yuborilgan.\nJavoblarni shu botga yuboring. Namuna: 1A2B3C...${activeWindow.test.totalQuestions}B`,
          { reply_markup: studentMenuKeyboard, protect_content: true },
        );
        return;
      }

      await ctx.reply(
        `Sizga ochiq test: ${activeWindow.test.lesson.book.title} | ${activeWindow.test.lesson.lessonNumber}-dars`,
        {
          protect_content: true,
          reply_markup: {
            inline_keyboard: [[{ text: "📝 Testni ochish", callback_data: `open_test:${activeWindow.testId}` }]],
          },
        },
      );
      return;
    }

    if (session.activeTestId) {
      const now = new Date();
      const activeWindow = session.activeWindowId
        ? await prisma.accessWindow.findFirst({
            where: {
              id: session.activeWindowId,
              studentId: actor.userId,
              testId: session.activeTestId,
              isActive: true,
              submittedAt: null,
              openFrom: { lte: now },
              openTo: { gte: now },
            },
            include: {
              test: {
                select: {
                  id: true,
                  totalQuestions: true,
                  answerKey: true,
                },
              },
            },
          })
        : null;

      if (!activeWindow) {
        clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
        session.activeTestId = undefined;
        session.activeWindowId = undefined;
        session.sentTestMessageIds = [];
        state.set(ctx.from.id, session);
        await ctx.reply("Sizda aktiv test yo'q.", { reply_markup: studentMenuKeyboard });
        return;
      }

      const test = activeWindow.test;

      try {
        const parsed = parseAnswerText(text, test.totalQuestions);

        const missingNumbers: number[] = [];
        for (let i = 0; i < test.totalQuestions; i += 1) {
          if (!parsed.byQuestion[i]) missingNumbers.push(i + 1);
        }

        if (!allowPartialSubmissions && missingNumbers.length > 0) {
          const preview = missingNumbers.slice(0, 20).join(", ");
          await ctx.reply(
            `Javob to'liq emas. ${test.totalQuestions} ta savolning barchasini kiriting. Yetishmayotgan: ${preview}${missingNumbers.length > 20 ? " ..." : ""}`,
            { reply_markup: studentMenuKeyboard },
          );
          return;
        }

        const key = test.answerKey as string[];

        let score = 0;
        const details: Array<{
          questionNumber: number;
          givenAnswer: string | null;
          correctAnswer: string;
          isCorrect: boolean;
        }> = [];

        for (let i = 0; i < test.totalQuestions; i += 1) {
          const given = parsed.byQuestion[i] || null;
          const correct = key[i] ?? "";
          const isCorrect = given === correct;
          if (isCorrect) score += 1;

          details.push({
            questionNumber: i + 1,
            givenAnswer: given,
            correctAnswer: correct,
            isCorrect,
          });
        }

        await prisma.$transaction(async (tx) => {
          const submittedAt = new Date();
          const lockWindow = await tx.accessWindow.updateMany({
            where: {
              id: activeWindow.id,
              studentId: actor.userId,
              testId: test.id,
              isActive: true,
              submittedAt: null,
            },
            data: {
              submittedAt,
              isActive: false,
              openTo: submittedAt,
            },
          });

          if (lockWindow.count === 0) {
            throw new Error("WINDOW_ALREADY_SUBMITTED");
          }

          const submission = await tx.submission.create({
            data: {
              studentId: actor.userId,
              testId: test.id,
              rawAnswerText: text,
              parsedAnswers: parsed.byQuestion,
              score,
            },
          });

          await tx.submissionDetail.createMany({
            data: details.map((d) => ({ ...d, submissionId: submission.id })),
          });

          await tx.auditLog.create({
            data: {
              actorId: actor.userId,
              action: "SUBMIT",
              entity: "Submission",
              entityId: submission.id,
            },
          });
        });

        if (ctx.chat) {
          for (const messageId of session.sentTestMessageIds) {
            try {
              await ctx.api.deleteMessage(ctx.chat.id, messageId);
            } catch {
              // ignore delete failures
            }
          }
        }

        clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
        session.activeTestId = undefined;
        session.activeWindowId = undefined;
        session.sentTestMessageIds = [];
        state.set(ctx.from.id, session);

        await ctx.reply("Qabul qilindi ✅", { reply_markup: studentMenuKeyboard });
        return;
      } catch (error) {
        if (error instanceof Error && error.message === "WINDOW_ALREADY_SUBMITTED") {
          clearPendingGroupAccess(ctx.from.id, session.activeWindowId);
          session.activeTestId = undefined;
          session.activeWindowId = undefined;
          session.sentTestMessageIds = [];
          state.set(ctx.from.id, session);
          await ctx.reply("Sizda aktiv test yo'q.", { reply_markup: studentMenuKeyboard });
          return;
        }

        await ctx.reply(`Format xato. Namuna: 1A2B3C...${test.totalQuestions}B`, {
          reply_markup: studentMenuKeyboard,
        });
        return;
      }
    }

    await ctx.reply("Kerakli tugmani tanlang.", { reply_markup: studentMenuKeyboard });
    return;
  }

  if (session.awaitingAppeal && !parentButtons.has(text)) {
    const saved = await createAppealFromParent(ctx, actor, text);
    if (saved) {
      session.awaitingAppeal = false;
      state.set(ctx.from.id, session);
    }
    return;
  }

  if (text === PARENT_BTN_RESULTS) {
    session.awaitingAppeal = false;
    state.set(ctx.from.id, session);
    await showParentResults(ctx, actor);
    return;
  }

  if (text === PARENT_BTN_DEBT) {
    session.awaitingAppeal = false;
    state.set(ctx.from.id, session);
    await showParentDebt(ctx, actor);
    return;
  }

  if (text === PARENT_BTN_APPEAL) {
    session.awaitingAppeal = true;
    state.set(ctx.from.id, session);
    await ctx.reply(
      "E'tirozingizni yozishingiz mumkin. Bu xabar to'g'ridan-to'g'ri loyiha rahbari Husniddin Ergashevga yuboriladi.",
      { reply_markup: parentMenuKeyboard },
    );
    return;
  }

  if (!parentButtons.has(text)) {
    await createAppealFromParent(ctx, actor, text);
    return;
  }

  await ctx.reply("Kerakli tugmani tanlang.", { reply_markup: parentMenuKeyboard });
});

bot.callbackQuery(/open_test:(.+)/, async (ctx) => {
  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: "Xatolik: foydalanuvchi aniqlanmadi", show_alert: true });
    return;
  }

  const actor = await resolveActorByTelegramUserId(ctx.from.id);
  if (!actor || actor.type !== "STUDENT") {
    await ctx.answerCallbackQuery({ text: "Avval /start qiling", show_alert: true });
    return;
  }

  const testId = ctx.match[1];
  const activeWindow = await getActiveWindow(actor.userId);
  if (!activeWindow || activeWindow.testId !== testId) {
    await ctx.answerCallbackQuery({ text: "Bu test hozir yopiq", show_alert: true });
    return;
  }

  const session = getSessionState(ctx.from.id);
  if (activeWindow.openedAt) {
    session.activeTestId = testId;
    session.activeWindowId = activeWindow.id;
    state.set(ctx.from.id, session);
    await ctx.answerCallbackQuery({
      text: "Test allaqachon ochilgan. Javoblarni yuboring.",
      show_alert: true,
    });
    return;
  }

  const openedAt = new Date();
  const markOpened = await prisma.accessWindow.updateMany({
    where: {
      id: activeWindow.id,
      openedAt: null,
      isActive: true,
      openFrom: { lte: openedAt },
      openTo: { gte: openedAt },
    },
    data: { openedAt },
  });

  if (markOpened.count === 0) {
    await ctx.answerCallbackQuery({
      text: "Bu tugma allaqachon ishlatilgan.",
      show_alert: true,
    });
    return;
  }

  session.activeTestId = testId;
  session.activeWindowId = activeWindow.id;
  session.sentTestMessageIds = [];

  try {
    if (activeWindow.test.images.length === 0) {
      throw new Error("TEST_CONTENT_NOT_SET");
    }

    for (const image of activeWindow.test.images) {
      const messageId = await sendTestImage(ctx, image.imageUrl);
      if (messageId) session.sentTestMessageIds.push(messageId);
    }

    const instruction = await ctx.reply(
      `Javoblarni bitta qatorda yuboring. Masalan: 1A2B3C...${activeWindow.test.totalQuestions}B`,
      { reply_markup: studentMenuKeyboard, protect_content: true },
    );

    if (instruction?.message_id) {
      session.sentTestMessageIds.push(instruction.message_id);
    }
  } catch (error) {
    console.error("OPEN_TEST_SEND_ERROR", error);
    await prisma.accessWindow.update({
      where: { id: activeWindow.id },
      data: { openedAt: null },
    });
    clearPendingGroupAccess(ctx.from.id, activeWindow.id);
    const errorText =
      error instanceof Error && error.message === "TEST_CONTENT_NOT_SET"
        ? "Bu testga rasm biriktirilmagan. Admin 2 ta rasm URL ni to'ldirishi kerak."
        : "Testni ochishda xatolik bo'ldi, qayta urinib ko'ring.";
    await ctx.answerCallbackQuery({
      text: errorText,
      show_alert: true,
    });
    return;
  }

  state.set(ctx.from.id, session);
  await ctx.answerCallbackQuery();
});

bot.catch((err) => {
  console.error("BOT_ERROR", err.error);
});

async function bootstrap() {
  const me = await bot.api.getMe();
  console.log(`Bot: @${me.username ?? me.first_name} | NODE_ENV=${process.env.NODE_ENV ?? "undefined"}`);

  const useWebhook = isProduction && Boolean(webhookPath) && Boolean(webhookUrl);

  if (useWebhook) {
    console.log("Mode: webhook");
    await bot.api.setWebhook(`${webhookUrl}${webhookPath}`);
    const handler = webhookCallback(bot, "http");

    createServer((req, res) => {
      if (req.method === "POST" && req.url === webhookPath) {
        return handler(req, res);
      }
      res.statusCode = 200;
      res.end("OK");
    }).listen(port, () => {
      console.log(`Bot webhook rejimida ishga tushdi: ${port}`);
    });
    return;
  }

  console.log("Mode: long-polling");
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  await bot.start();
  console.log("Bot long-polling rejimida ishga tushdi");
}

bootstrap();

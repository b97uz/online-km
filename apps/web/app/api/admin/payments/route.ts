import { PaymentStatus } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { normalizeUzPhone, phoneVariants } from "@/lib/phone";
import {
  addOneMonthFromDateInput,
  buildPeriodNote,
  calculateTodayAwareDebtMap,
  parseDateInput,
} from "@/lib/payment-debt";
import { isPaymentTableMissingError } from "@/lib/payment-table";
import {
  getDebt,
  getPaymentStatus,
  getRequiredNet,
  isValidMonth,
  parseNonNegativeInt,
  parsePaymentMethod,
  parsePaymentStatus,
  parseSubject,
} from "@/lib/payments";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function parseSubjectFromGroupFan(value: string): "CHEMISTRY" | "BIOLOGY" | "BOTH" | null {
  const raw = value.trim().toLowerCase();
  const hasChemistry = raw.includes("kimyo") || raw.includes("chemistry");
  const hasBiology = raw.includes("biologiya") || raw.includes("biology");
  if (hasChemistry && hasBiology) return "BOTH";
  if (hasChemistry) return "CHEMISTRY";
  if (hasBiology) return "BIOLOGY";
  return null;
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function redirectAdmin(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/payments", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function readInput(req: Request): Promise<Record<string, string>> {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  if (json) {
    const data = (await req.json()) as Record<string, unknown>;
    return {
      studentId: String(data.studentId ?? ""),
      studentPhone: String(data.studentPhone ?? ""),
      groupId: String(data.groupId ?? ""),
      periodStart: String(data.periodStart ?? ""),
      subject: String(data.subject ?? ""),
      month: String(data.month ?? ""),
      amountRequired: String(data.amountRequired ?? ""),
      amountPaid: String(data.amountPaid ?? ""),
      discount: String(data.discount ?? "0"),
      paymentMethod: String(data.paymentMethod ?? ""),
      note: String(data.note ?? ""),
      paidAt: String(data.paidAt ?? ""),
    };
  }

  const form = await req.formData();
  return {
    studentId: String(form.get("studentId") ?? ""),
    studentPhone: String(form.get("studentPhone") ?? ""),
    groupId: String(form.get("groupId") ?? ""),
    periodStart: String(form.get("periodStart") ?? ""),
    subject: String(form.get("subject") ?? ""),
    month: String(form.get("month") ?? ""),
    amountRequired: String(form.get("amountRequired") ?? ""),
    amountPaid: String(form.get("amountPaid") ?? ""),
    discount: String(form.get("discount") ?? "0"),
    paymentMethod: String(form.get("paymentMethod") ?? ""),
    note: String(form.get("note") ?? ""),
    paidAt: String(form.get("paidAt") ?? ""),
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const asJson = isJson(req);
  const input = await readInput(req);

  const studentId = input.studentId.trim();
  const studentPhone = normalizeUzPhone(input.studentPhone);
  const groupId = input.groupId.trim();
  const periodStartRaw = input.periodStart.trim();
  let subject = parseSubject(input.subject.trim());
  let month = input.month.trim();
  let amountRequired = parseNonNegativeInt(input.amountRequired.trim());
  const amountPaid = parseNonNegativeInt(input.amountPaid.trim());
  const discount = parseNonNegativeInt(input.discount.trim() || "0");
  const paymentMethod = parsePaymentMethod(input.paymentMethod.trim());
  const note = input.note.trim() || null;
  const paidAt = input.paidAt.trim() ? new Date(input.paidAt.trim()) : new Date();

  if ((!studentId && !studentPhone) || !paymentMethod) {
    if (asJson) return NextResponse.json({ ok: false, error: "Student va paymentMethod majburiy" }, { status: 400 });
    return redirectAdmin(req, "Student va paymentMethod majburiy", true);
  }

  if (amountPaid === null || discount === null) {
    if (asJson) return NextResponse.json({ ok: false, error: "Summa maydonlari noto'g'ri" }, { status: 400 });
    return redirectAdmin(req, "Summa maydonlari noto'g'ri", true);
  }

  if (Number.isNaN(paidAt.getTime())) {
    if (asJson) return NextResponse.json({ ok: false, error: "paidAt noto'g'ri" }, { status: 400 });
    return redirectAdmin(req, "To'lov sanasi noto'g'ri", true);
  }

  let student = null;
  if (studentId) {
    student = await prisma.student.findUnique({ where: { id: studentId } });
  } else if (studentPhone) {
    student = await prisma.student.findFirst({
      where: {
        OR: phoneVariants(studentPhone).map((phone) => ({ phone })),
      },
    });
  }

  if (!student) {
    if (asJson) return NextResponse.json({ ok: false, error: "Student topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Student topilmadi", true);
  }

  let notePrefix: string | null = null;
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  if (groupId) {
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        studentId: student.id,
        groupId,
        status: {
          in: ["TRIAL", "ACTIVE", "PAUSED"],
        },
      },
      include: {
        group: {
          select: {
            code: true,
            fan: true,
            priceMonthly: true,
          },
        },
      },
    });

    if (!enrollment) {
      if (asJson) return NextResponse.json({ ok: false, error: "Student tanlangan guruhda topilmadi" }, { status: 400 });
      return redirectAdmin(req, "Student tanlangan guruhda topilmadi", true);
    }

    periodStart = parseDateInput(periodStartRaw);
    if (!periodStart) {
      if (asJson) return NextResponse.json({ ok: false, error: "Boshlash kuni YYYY-MM-DD bo'lishi kerak" }, { status: 400 });
      return redirectAdmin(req, "Boshlash kuni to'g'ri formatda bo'lishi kerak", true);
    }
    periodEnd = addOneMonthFromDateInput(periodStart);

    const subjectFromGroup = parseSubjectFromGroupFan(enrollment.group.fan);
    if (!subjectFromGroup) {
      if (asJson) return NextResponse.json({ ok: false, error: "Guruh fani noto'g'ri" }, { status: 400 });
      return redirectAdmin(req, "Guruh fani noto'g'ri", true);
    }

    subject = parseSubject(subjectFromGroup);
    month = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`;
    amountRequired = enrollment.group.priceMonthly;
    notePrefix = `Guruh: ${enrollment.group.code} | Davr: ${buildPeriodNote(periodStart, periodEnd)}`;
  }

  if (!subject || !isValidMonth(month) || amountRequired === null) {
    if (asJson) return NextResponse.json({ ok: false, error: "Subject/month/required summa noto'g'ri" }, { status: 400 });
    return redirectAdmin(req, "To'lov ma'lumotlari noto'g'ri", true);
  }

  const finalNote = [notePrefix, note].filter(Boolean).join("\n").trim() || null;

  let payment: Awaited<ReturnType<typeof prisma.payment.create>>;
  try {
    payment = await prisma.$transaction(async (tx) => {
      if (groupId) {
        const pendingAutoDebt = await tx.payment.findFirst({
          where: {
            studentId: student.id,
            groupId,
            isDeleted: false,
            note: {
              contains: "Auto qarzdorlik: SINOV -> AKTIV",
            },
          },
          orderBy: { createdAt: "desc" },
        });

        if (pendingAutoDebt) {
          const pendingRequiredNet = Math.max(0, pendingAutoDebt.amountRequired - pendingAutoDebt.discount);
          const pendingDebt = Math.max(0, pendingRequiredNet - pendingAutoDebt.amountPaid);

          if (pendingDebt > 0) {
            const mergedPaid = Math.max(0, pendingAutoDebt.amountPaid) + amountPaid;
            const mergedDiscount = discount;
            const mergedStatus = getPaymentStatus(amountRequired, mergedDiscount, mergedPaid);

            const updated = await tx.payment.update({
              where: { id: pendingAutoDebt.id },
              data: {
                subject,
                month,
                amountRequired,
                amountPaid: mergedPaid,
                discount: mergedDiscount,
                paymentMethod,
                status: mergedStatus,
                paidAt,
                periodStart,
                periodEnd,
                note: finalNote ?? pendingAutoDebt.note,
                isDeleted: false,
                deletedAt: null,
                deletedById: null,
              },
            });

            await tx.auditLog.create({
              data: {
                actorId: session.userId,
                action: "UPDATE",
                entity: "Payment",
                entityId: updated.id,
                payload: { studentId: student.id, month, subject, status: mergedStatus, autoDebtSettled: true },
              },
            });

            return updated;
          }
        }
      }

      const createdStatus = getPaymentStatus(amountRequired, discount, amountPaid);
      const created = await tx.payment.create({
        data: {
          studentId: student.id,
          subject,
          month,
          amountRequired,
          amountPaid,
          discount,
          paymentMethod,
          status: createdStatus,
          paidAt,
          groupId: groupId || null,
          periodStart,
          periodEnd,
          note: finalNote,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "CREATE",
          entity: "Payment",
          entityId: created.id,
          payload: { studentId: student.id, month, subject, status: createdStatus },
        },
      });

      return created;
    });
  } catch (error) {
    if (isPaymentTableMissingError(error)) {
      if (asJson) return NextResponse.json({ ok: false, error: "Payments jadvali yo'q. Migratsiyani ishga tushiring." }, { status: 503 });
      return redirectAdmin(req, "Payments jadvali yo'q. `prisma migrate deploy` ni ishga tushiring.", true);
    }
    console.error("ADMIN_PAYMENT_CREATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "To'lov saqlanmadi" }, { status: 500 });
    return redirectAdmin(req, "To'lov saqlanmadi", true);
  }

  if (asJson) {
    return NextResponse.json({
      ok: true,
      payment: {
        ...payment,
        requiredNet: getRequiredNet(payment.amountRequired, payment.discount),
        debt: getDebt(payment.amountRequired, payment.discount, payment.amountPaid),
      },
    });
  }
  return redirectAdmin(req, "To'lov saqlandi");
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const month = (url.searchParams.get("month") ?? "").trim();
  const subject = parseSubject((url.searchParams.get("subject") ?? "").trim());
  const status = parsePaymentStatus((url.searchParams.get("status") ?? "").trim());
  const studentPhone = normalizeUzPhone(url.searchParams.get("studentPhone") ?? "");

  const loadPayments = () =>
    prisma.payment.findMany({
      where: {
        ...(month && isValidMonth(month) ? { month } : {}),
        ...(subject ? { subject } : {}),
        ...(status ? { status } : {}),
        ...(studentPhone
          ? {
              student: {
                OR: phoneVariants(studentPhone).map((phone) => ({ phone })),
              },
            }
          : {}),
      },
      include: {
        student: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            status: true,
          },
        },
        group: {
          select: {
            id: true,
            code: true,
            status: true,
            priceMonthly: true,
          },
        },
      },
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      take: 1000,
    });

  let payments = [] as Awaited<ReturnType<typeof loadPayments>>;
  try {
    payments = await loadPayments();
  } catch (error) {
    if (isPaymentTableMissingError(error)) {
      return NextResponse.json({ ok: false, error: "Payments jadvali yo'q. Migratsiyani ishga tushiring." }, { status: 503 });
    }
    throw error;
  }

  const activePayments = payments.filter((payment) => !payment.isDeleted);

  const todayAwareDebt = calculateTodayAwareDebtMap(
    activePayments.map((payment) => ({
      id: payment.id,
      studentId: payment.studentId,
      groupId: payment.groupId,
      amountRequired: payment.amountRequired,
      amountPaid: payment.amountPaid,
      discount: payment.discount,
      periodEnd: payment.periodEnd,
      group: payment.group
        ? {
            status: payment.group.status,
            priceMonthly: payment.group.priceMonthly,
          }
        : null,
    })),
  );

  return NextResponse.json({
    ok: true,
    payments: payments.map((payment) => {
      const requiredNet = getRequiredNet(payment.amountRequired, payment.discount);
      const debtInfo = todayAwareDebt.byPaymentId.get(payment.id);
      return {
        ...payment,
        requiredNet,
        debt: payment.isDeleted
          ? 0
          : debtInfo?.totalDebt ?? getDebt(payment.amountRequired, payment.discount, payment.amountPaid),
        extraDebt: debtInfo?.extraDebt ?? 0,
        extraPeriods: debtInfo?.extraPeriods ?? 0,
      };
    }),
    summary: {
      total: activePayments.length,
      paid: activePayments.filter((x) => x.status === PaymentStatus.PAID).length,
      partial: activePayments.filter((x) => x.status === PaymentStatus.PARTIAL).length,
      debt: Array.from(todayAwareDebt.byPaymentId.values()).filter((x) => x.totalDebt > 0).length,
      totalDebt: todayAwareDebt.totalDebt,
    },
  });
}

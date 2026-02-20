import { EnrollmentStatus, PaymentMethod, PaymentStatus, Subjects } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { isUzE164, normalizeUzPhone, phoneVariants } from "@/lib/phone";
import { addOneMonthFromDateInput, buildPeriodNote, parseDateInput } from "@/lib/payment-debt";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function parseEnrollmentStatus(value: string): EnrollmentStatus {
  if (value === "TRIAL") return EnrollmentStatus.TRIAL;
  if (value === "PAUSED") return EnrollmentStatus.PAUSED;
  if (value === "LEFT") return EnrollmentStatus.LEFT;
  return EnrollmentStatus.ACTIVE;
}

function parseSubjectFromGroupFan(value: string): Subjects | null {
  const raw = value.trim().toLowerCase();
  const hasChemistry = raw.includes("kimyo") || raw.includes("chemistry");
  const hasBiology = raw.includes("biologiya") || raw.includes("biology");
  if (hasChemistry && hasBiology) return Subjects.BOTH;
  if (hasChemistry) return Subjects.CHEMISTRY;
  if (hasBiology) return Subjects.BIOLOGY;
  return null;
}

function getRedirectPath(raw: string): string {
  const path = raw.trim();
  if (path.startsWith("/admin")) return path;
  return "/admin/groups";
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function redirectAdmin(req: Request, message: string, isError = false, redirectPath = "/admin/groups") {
  const url = buildUrl(redirectPath, req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function readInput(req: Request): Promise<Record<string, string>> {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  if (json) {
    const body = (await req.json()) as Record<string, unknown>;
    return {
      groupId: String(body.groupId ?? ""),
      phone: String(body.phone ?? ""),
      studentId: String(body.studentId ?? ""),
      status: String(body.status ?? "ACTIVE"),
      studyStartDate: String(body.studyStartDate ?? ""),
      redirectTo: String(body.redirectTo ?? ""),
    };
  }

  const form = await req.formData();
  return {
    groupId: String(form.get("groupId") ?? ""),
    phone: String(form.get("phone") ?? ""),
    studentId: String(form.get("studentId") ?? ""),
    status: String(form.get("status") ?? "ACTIVE"),
    studyStartDate: String(form.get("studyStartDate") ?? ""),
    redirectTo: String(form.get("redirectTo") ?? ""),
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const asJson = isJson(req);
  const input = await readInput(req);

  const groupId = input.groupId.trim();
  const studentIdRaw = input.studentId.trim();
  const phone = normalizeUzPhone(input.phone);
  const status = parseEnrollmentStatus(input.status);
  const studyStartDateRaw = input.studyStartDate.trim();
  const parsedStudyStartDate = studyStartDateRaw ? parseDateInput(studyStartDateRaw) : null;
  const redirectPath = getRedirectPath(input.redirectTo);

  if (!groupId || (!studentIdRaw && !phone)) {
    if (asJson) return NextResponse.json({ ok: false, error: "groupId va student phone/id kerak" }, { status: 400 });
    return redirectAdmin(req, "groupId va student phone/id kerak", true, redirectPath);
  }

  if (!studentIdRaw && !isUzE164(phone)) {
    if (asJson) return NextResponse.json({ ok: false, error: "Telefon +998XXXXXXXXX formatda bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Telefon +998XXXXXXXXX formatda bo'lishi kerak", true, redirectPath);
  }

  if (studyStartDateRaw && !parsedStudyStartDate) {
    if (asJson) return NextResponse.json({ ok: false, error: "Boshlash sanasi YYYY-MM-DD bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Boshlash sanasi noto'g'ri", true, redirectPath);
  }

  const group = await prisma.groupCatalog.findUnique({ where: { id: groupId } });
  if (!group) {
    if (asJson) return NextResponse.json({ ok: false, error: "Guruh topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Guruh topilmadi", true, redirectPath);
  }

  const student = studentIdRaw
    ? await prisma.student.findUnique({ where: { id: studentIdRaw } })
    : await prisma.student.findFirst({
        where: {
          OR: phoneVariants(phone).map((value) => ({ phone: value })),
        },
      });

  if (!student) {
    if (asJson) return NextResponse.json({ ok: false, error: "Student topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Student topilmadi", true, redirectPath);
  }

  if (student.status === "BLOCKED") {
    if (asJson) return NextResponse.json({ ok: false, error: "BLOCKED studentni qo'shib bo'lmaydi" }, { status: 400 });
    return redirectAdmin(req, "BLOCKED studentni qo'shib bo'lmaydi", true, redirectPath);
  }

  try {
    const enrollment = await prisma.$transaction(async (tx) => {
      const existingEnrollment = await tx.enrollment.findUnique({
        where: {
          studentId_groupId: {
            studentId: student.id,
            groupId: group.id,
          },
        },
      });

      if (status === EnrollmentStatus.ACTIVE && (!existingEnrollment || existingEnrollment.status !== EnrollmentStatus.ACTIVE)) {
        const activeCount = await tx.enrollment.count({
          where: {
            groupId: group.id,
            status: EnrollmentStatus.ACTIVE,
          },
        });

        if (activeCount >= group.capacity) {
          throw new Error("GROUP_CAPACITY_FULL");
        }
      }

      const upserted = await tx.enrollment.upsert({
        where: {
          studentId_groupId: {
            studentId: student.id,
            groupId: group.id,
          },
        },
        update: {
          status,
          ...(parsedStudyStartDate ? { studyStartDate: parsedStudyStartDate } : {}),
        },
        create: {
          studentId: student.id,
          groupId: group.id,
          status,
          studyStartDate: parsedStudyStartDate ?? new Date(),
        },
      });

      if (existingEnrollment?.status === EnrollmentStatus.TRIAL && status === EnrollmentStatus.ACTIVE) {
        const subject = parseSubjectFromGroupFan(group.fan);
        if (subject) {
          const alreadyHasPayment = await tx.payment.findFirst({
            where: {
              studentId: student.id,
              groupId: group.id,
              isDeleted: false,
            },
            select: { id: true },
          });

          if (!alreadyHasPayment) {
            const periodStart = new Date(
              Date.UTC(
                (upserted.studyStartDate ?? existingEnrollment.studyStartDate ?? existingEnrollment.createdAt).getUTCFullYear(),
                (upserted.studyStartDate ?? existingEnrollment.studyStartDate ?? existingEnrollment.createdAt).getUTCMonth(),
                (upserted.studyStartDate ?? existingEnrollment.studyStartDate ?? existingEnrollment.createdAt).getUTCDate(),
              ),
            );
            const periodEnd = addOneMonthFromDateInput(periodStart);
            await tx.payment.create({
              data: {
                studentId: student.id,
                groupId: group.id,
                subject,
                month: `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`,
                periodStart,
                periodEnd,
                amountRequired: group.priceMonthly,
                amountPaid: 0,
                discount: 0,
                paymentMethod: PaymentMethod.CASH,
                status: PaymentStatus.DEBT,
                note: `Auto qarzdorlik: SINOV -> AKTIV | Davr: ${buildPeriodNote(periodStart, periodEnd)}`,
              },
            });
          }
        }
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "CREATE",
          entity: "Enrollment",
          entityId: upserted.id,
          payload: {
            groupId: group.id,
            studentId: student.id,
            status,
            studyStartDate: upserted.studyStartDate,
          },
        },
      });

      return upserted;
    });

    if (asJson) return NextResponse.json({ ok: true, enrollment });
    return redirectAdmin(req, "Student guruhga biriktirildi", false, redirectPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";

    if (message === "GROUP_CAPACITY_FULL") {
      if (asJson) return NextResponse.json({ ok: false, error: "Guruh sig'imi to'lgan" }, { status: 400 });
      return redirectAdmin(req, "Guruh sig'imi to'lgan", true, redirectPath);
    }

    console.error("ADMIN_ENROLLMENT_CREATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Enrollment yaratilmadi" }, { status: 500 });
    return redirectAdmin(req, "Enrollment yaratilmadi", true, redirectPath);
  }
}

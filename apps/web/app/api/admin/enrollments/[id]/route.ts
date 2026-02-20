import { EnrollmentStatus, PaymentMethod, PaymentStatus, Subjects } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
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

async function patchEnrollment(
  req: Request,
  id: string,
  statusRaw: string,
  studyStartDateRaw: string,
  asJson: boolean,
  redirectTo = "",
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });
  const redirectPath = getRedirectPath(redirectTo);
  const parsedStudyStartDate = studyStartDateRaw ? parseDateInput(studyStartDateRaw) : null;

  if (studyStartDateRaw && !parsedStudyStartDate) {
    if (asJson) return NextResponse.json({ ok: false, error: "Boshlash sanasi YYYY-MM-DD bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Boshlash sanasi noto'g'ri", true, redirectPath);
  }

  const enrollment = await prisma.enrollment.findUnique({
    where: { id },
    include: {
      group: {
        select: {
          id: true,
          fan: true,
          capacity: true,
          priceMonthly: true,
        },
      },
    },
  });
  if (!enrollment) {
    if (asJson) return NextResponse.json({ ok: false, error: "Enrollment topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Enrollment topilmadi", true, redirectPath);
  }

  const status = parseEnrollmentStatus(statusRaw);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (status === EnrollmentStatus.ACTIVE && enrollment.status !== EnrollmentStatus.ACTIVE) {
        const activeCount = await tx.enrollment.count({
          where: {
            groupId: enrollment.group.id,
            status: EnrollmentStatus.ACTIVE,
            id: {
              not: enrollment.id,
            },
          },
        });

        if (activeCount >= enrollment.group.capacity) {
          throw new Error("GROUP_CAPACITY_FULL");
        }
      }

      const result = await tx.enrollment.update({
        where: { id: enrollment.id },
        data: {
          status,
          ...(parsedStudyStartDate ? { studyStartDate: parsedStudyStartDate } : {}),
        },
      });

      if (enrollment.status === EnrollmentStatus.TRIAL && status === EnrollmentStatus.ACTIVE) {
        const subject = parseSubjectFromGroupFan(enrollment.group.fan);
        if (subject) {
          const alreadyHasPayment = await tx.payment.findFirst({
            where: {
              studentId: enrollment.studentId,
              groupId: enrollment.group.id,
              isDeleted: false,
            },
            select: { id: true },
          });

          if (!alreadyHasPayment) {
            const periodStartSource = result.studyStartDate ?? enrollment.studyStartDate ?? enrollment.createdAt;
            const periodStart = new Date(
              Date.UTC(
                periodStartSource.getUTCFullYear(),
                periodStartSource.getUTCMonth(),
                periodStartSource.getUTCDate(),
              ),
            );
            const periodEnd = addOneMonthFromDateInput(periodStart);
            await tx.payment.create({
              data: {
                studentId: enrollment.studentId,
                groupId: enrollment.group.id,
                subject,
                month: `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`,
                periodStart,
                periodEnd,
                amountRequired: enrollment.group.priceMonthly,
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
          action: "UPDATE",
          entity: "Enrollment",
          entityId: enrollment.id,
          payload: { status, studyStartDate: result.studyStartDate },
        },
      });

      return result;
    });

    if (asJson) return NextResponse.json({ ok: true, enrollment: updated });
    return redirectAdmin(req, "Enrollment status yangilandi", false, redirectPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    if (message === "GROUP_CAPACITY_FULL") {
      if (asJson) return NextResponse.json({ ok: false, error: "Guruh sig'imi to'lgan" }, { status: 400 });
      return redirectAdmin(req, "Guruh sig'imi to'lgan", true, redirectPath);
    }

    console.error("ADMIN_ENROLLMENT_PATCH_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Enrollment status yangilanmadi" }, { status: 500 });
    return redirectAdmin(req, "Enrollment status yangilanmadi", true, redirectPath);
  }
}

async function deleteEnrollment(req: Request, id: string, asJson: boolean, redirectTo = "") {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });
  const redirectPath = getRedirectPath(redirectTo);

  const enrollment = await prisma.enrollment.findUnique({ where: { id } });
  if (!enrollment) {
    if (asJson) return NextResponse.json({ ok: false, error: "Enrollment topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Enrollment topilmadi", true, redirectPath);
  }

  await prisma.$transaction(async (tx) => {
    await tx.enrollment.delete({ where: { id: enrollment.id } });
    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        action: "DELETE",
        entity: "Enrollment",
        entityId: enrollment.id,
      },
    });
  });

  if (asJson) return NextResponse.json({ ok: true });
  return redirectAdmin(req, "Student guruhdan chiqarildi", false, redirectPath);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const data = (await req.json()) as { status?: string; studyStartDate?: string; redirectTo?: string };
  return patchEnrollment(
    req,
    id,
    String(data.status ?? "ACTIVE"),
    String(data.studyStartDate ?? ""),
    true,
    String(data.redirectTo ?? ""),
  );
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deleteEnrollment(req, id, isJson(req));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const method = String(form.get("_method") ?? "").toUpperCase();

  if (method === "PATCH") {
    return patchEnrollment(
      req,
      id,
      String(form.get("status") ?? "ACTIVE"),
      String(form.get("studyStartDate") ?? ""),
      false,
      String(form.get("redirectTo") ?? ""),
    );
  }

  if (method === "DELETE") {
    return deleteEnrollment(req, id, false, String(form.get("redirectTo") ?? ""));
  }

  return new NextResponse("Method Not Allowed", { status: 405 });
}

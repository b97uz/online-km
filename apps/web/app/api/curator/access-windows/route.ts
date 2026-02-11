import { Role } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { isUzE164, normalizeUzPhone, phoneVariants } from "@/lib/phone";
import { NextResponse } from "next/server";

function redirectBack(req: Request, message: string, isError = false) {
  const url = new URL("/curator/access-windows", req.url);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "CURATOR") return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const studentPhone = normalizeUzPhone(String(form.get("studentPhone") ?? ""));
  const phoneOr = phoneVariants(studentPhone).map((value) => ({ phone: value }));
  const testId = String(form.get("testId") ?? "").trim();
  const openFrom = new Date(String(form.get("openFrom") ?? ""));
  const openTo = new Date(String(form.get("openTo") ?? ""));

  if (!studentPhone || !testId || Number.isNaN(openFrom.getTime()) || Number.isNaN(openTo.getTime())) {
    return redirectBack(req, "Ma'lumotlar noto'g'ri", true);
  }

  if (!isUzE164(studentPhone)) {
    return redirectBack(req, "Telefon +998XXXXXXXXX formatda bo'lishi kerak", true);
  }

  if (openFrom >= openTo) {
    return redirectBack(req, "Vaqt oralig'i noto'g'ri", true);
  }

  const registryStudent = await prisma.student.findFirst({
    where: {
      OR: phoneOr,
      status: "ACTIVE",
      enrollments: {
        some: {
          status: {
            in: ["TRIAL", "ACTIVE"],
          },
          group: {
            curatorId: session.userId,
            status: { not: "YOPIQ" },
          },
        },
      },
    },
  });

  let studentUserId: string | null = null;

  if (registryStudent) {
    try {
      const ensuredUser = await prisma.$transaction(async (tx) => {
        const existingUser = registryStudent.userId
          ? await tx.user.findUnique({ where: { id: registryStudent.userId } })
          : await tx.user.findFirst({ where: { OR: phoneOr } });

        if (existingUser && existingUser.role !== Role.STUDENT) {
          throw new Error("PHONE_USED_BY_OTHER_ROLE");
        }

        const user = existingUser
          ? await tx.user.update({
              where: { id: existingUser.id },
              data: {
                role: Role.STUDENT,
                phone: registryStudent.phone,
                isActive: true,
              },
            })
          : await tx.user.create({
              data: {
                role: Role.STUDENT,
                phone: registryStudent.phone,
                isActive: true,
              },
            });

        if (!registryStudent.userId || registryStudent.userId !== user.id) {
          await tx.student.update({
            where: { id: registryStudent.id },
            data: { userId: user.id },
          });
        }

        return user;
      });

      studentUserId = ensuredUser.id;
    } catch (error) {
      if (error instanceof Error && error.message === "PHONE_USED_BY_OTHER_ROLE") {
        return redirectBack(req, "Student telefoni boshqa role bilan band", true);
      }
      throw error;
    }
  } else {
    // Backward compatibility with old model.
    const oldStudent = await prisma.user.findFirst({
      where: {
        OR: phoneOr,
        role: "STUDENT",
        isActive: true,
        studentGroups: {
          some: {
            status: "ACTIVE",
            group: {
              curatorId: session.userId,
              isActive: true,
            },
          },
        },
      },
    });
    studentUserId = oldStudent?.id ?? null;
  }

  if (!studentUserId) return redirectBack(req, "Talaba sizning aktiv/sinov guruhingizda topilmadi", true);

  const test = await prisma.test.findFirst({
    where: { id: testId, isActive: true },
  });
  if (!test) return redirectBack(req, "Test topilmadi", true);

  const overlap = await prisma.accessWindow.findFirst({
    where: {
      studentId: studentUserId,
      testId,
      isActive: true,
      openFrom: { lte: openTo },
      openTo: { gte: openFrom },
    },
  });
  if (overlap) return redirectBack(req, "Bu oralikda oynasi allaqachon bor", true);

  const window = await prisma.accessWindow.create({
    data: {
      studentId: studentUserId,
      testId,
      openFrom,
      openTo,
      createdBy: session.userId,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: "CREATE",
      entity: "AccessWindow",
      entityId: window.id,
    },
  });

  return redirectBack(req, "Test oynasi ochildi");
}

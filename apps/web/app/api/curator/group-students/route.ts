import { GroupStudentStatus, Role } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { buildUrl } from "@/lib/url";
import { NextResponse } from "next/server";

function normalizePhone(value: string) {
  const cleaned = value.trim().replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

function parseStatus(value: string): GroupStudentStatus {
  if (value === "PAUSED") return GroupStudentStatus.PAUSED;
  if (value === "STOPPED") return GroupStudentStatus.STOPPED;
  return GroupStudentStatus.ACTIVE;
}

function redirectBack(req: Request, message: string, isError = false) {
  const url = buildUrl("/curator/students", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "CURATOR") return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const action = String(form.get("action") ?? "add");
  const groupId = String(form.get("groupId") ?? "").trim();

  if (!groupId) return redirectBack(req, "Group tanlanmagan", true);

  const group = await prisma.group.findFirst({
    where: { id: groupId, curatorId: session.userId, isActive: true },
  });

  if (!group) return redirectBack(req, "Guruh topilmadi", true);

  if (action === "remove") {
    const studentId = String(form.get("studentId") ?? "").trim();
    if (!studentId) return redirectBack(req, "Student ID topilmadi", true);

    await prisma.groupStudent.deleteMany({
      where: {
        groupId,
        studentId,
        group: { curatorId: session.userId },
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "DELETE",
        entity: "GroupStudent",
        entityId: `${groupId}:${studentId}`,
      },
    });

    return redirectBack(req, "Talaba guruhdan olindi");
  }

  if (action === "update") {
    const studentId = String(form.get("studentId") ?? "").trim();
    const status = parseStatus(String(form.get("status") ?? "ACTIVE"));

    const existing = await prisma.groupStudent.findFirst({
      where: {
        groupId,
        studentId,
        group: { curatorId: session.userId },
      },
    });

    if (!existing) return redirectBack(req, "Talaba guruhda topilmadi", true);

    await prisma.groupStudent.update({
      where: { groupId_studentId: { groupId, studentId } },
      data: { status },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "UPDATE",
        entity: "GroupStudent",
        entityId: `${groupId}:${studentId}`,
        payload: { status },
      },
    });

    return redirectBack(req, "Talaba statusi yangilandi");
  }

  const phone = normalizePhone(String(form.get("phone") ?? ""));
  const status = parseStatus(String(form.get("status") ?? "ACTIVE"));

  if (!phone) return redirectBack(req, "Telefon raqami noto'g'ri", true);

  const existingUser = await prisma.user.findUnique({ where: { phone } });
  if (existingUser && existingUser.role !== Role.STUDENT) {
    return redirectBack(req, "Bu telefon boshqa rolga biriktirilgan", true);
  }

  const student = existingUser
    ? await prisma.user.update({ where: { id: existingUser.id }, data: { isActive: true } })
    : await prisma.user.create({
        data: {
          role: Role.STUDENT,
          phone,
          isActive: true,
        },
      });

  await prisma.groupStudent.upsert({
    where: { groupId_studentId: { groupId, studentId: student.id } },
    update: { status },
    create: {
      groupId,
      studentId: student.id,
      status,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: "CREATE",
      entity: "GroupStudent",
      entityId: `${groupId}:${student.id}`,
      payload: { phone, status },
    },
  });

  return redirectBack(req, "Talaba guruhga qo'shildi");
}

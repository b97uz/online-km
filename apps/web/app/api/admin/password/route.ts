import bcrypt from "bcryptjs";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function redirectBack(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/settings", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const currentPassword = String(form.get("currentPassword") ?? "");
  const newPassword = String(form.get("newPassword") ?? "");
  const confirmPassword = String(form.get("confirmPassword") ?? "");

  if (!currentPassword || !newPassword || !confirmPassword) {
    return redirectBack(req, "Parol maydonlari to'liq emas", true);
  }

  if (newPassword.length < 8) {
    return redirectBack(req, "Yangi parol kamida 8 ta belgidan iborat bo'lishi kerak", true);
  }

  if (newPassword !== confirmPassword) {
    return redirectBack(req, "Yangi parol va tasdiq bir xil emas", true);
  }

  const admin = await prisma.user.findFirst({
    where: {
      id: session.userId,
      role: "ADMIN",
      isActive: true,
    },
  });

  if (!admin?.passwordHash) {
    return redirectBack(req, "Admin foydalanuvchi topilmadi", true);
  }

  const isCurrentValid = await bcrypt.compare(currentPassword, admin.passwordHash);
  if (!isCurrentValid) {
    return redirectBack(req, "Hozirgi parol noto'g'ri", true);
  }

  const sameAsOld = await bcrypt.compare(newPassword, admin.passwordHash);
  if (sameAsOld) {
    return redirectBack(req, "Yangi parol eski parol bilan bir xil bo'lmasin", true);
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: admin.id },
    data: { passwordHash: newPasswordHash },
  });

  await prisma.auditLog.create({
    data: {
      actorId: admin.id,
      action: "UPDATE",
      entity: "AdminPassword",
      entityId: admin.id,
    },
  });

  return redirectBack(req, "Admin paroli yangilandi");
}

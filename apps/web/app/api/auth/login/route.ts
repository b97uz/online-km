import bcrypt from "bcryptjs";
import { prisma } from "@km/db";
import { signSession, setSessionCookie } from "@/lib/auth";
import { buildUrl } from "@/lib/url";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const form = await req.formData();
  const loginType = String(form.get("loginType") ?? "");
  const password = String(form.get("password") ?? "");
  const adminUsernameFallback = process.env.ADMIN_USERNAME ?? "admin";

  if (!password) return NextResponse.redirect(buildUrl("/login?error=1", req), 303);

  let user = null;

  if (loginType === "admin") {
    const username = String(form.get("username") ?? "").trim() || adminUsernameFallback;
    user = await prisma.user.findFirst({ where: { username, role: "ADMIN", isActive: true } });
  } else {
    const rawPhone = String(form.get("phone") ?? "")
      .trim()
      .replace(/[^\d+]/g, "");
    const withPlus = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;
    const withoutPlus = withPlus.replace(/^\+/, "");
    user = await prisma.user.findFirst({
      where: {
        role: "CURATOR",
        isActive: true,
        OR: [{ phone: withPlus }, { phone: withoutPlus }],
      },
    });
  }

  if (!user?.passwordHash) return NextResponse.redirect(buildUrl("/login?error=1", req), 303);

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) return NextResponse.redirect(buildUrl("/login?error=1", req), 303);

  const token = signSession({
    userId: user.id,
    role: user.role as "ADMIN" | "CURATOR",
  });

  await setSessionCookie(token);

  await prisma.auditLog.create({
    data: { actorId: user.id, action: "LOGIN", entity: "User", entityId: user.id },
  });

  return NextResponse.redirect(buildUrl(user.role === "ADMIN" ? "/admin" : "/curator", req), 303);
}

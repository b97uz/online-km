import bcrypt from "bcryptjs";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { parseCuratorWorkDays } from "@/lib/group-schedule";
import { isUzE164, normalizeUzPhone } from "@/lib/phone";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function normalizeClock(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function toMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const form = await req.formData();
  const fullName = String(form.get("fullName") ?? "").trim();
  const phone = normalizeUzPhone(String(form.get("phone") ?? ""));
  const password = String(form.get("password") ?? "");
  const workStart = normalizeClock(String(form.get("workStart") ?? ""));
  const workEnd = normalizeClock(String(form.get("workEnd") ?? ""));
  const workDays = parseCuratorWorkDays(String(form.get("workDays") ?? ""));

  if (!fullName || !phone || !password || !workStart || !workEnd || !workDays) {
    const errorUrl = buildUrl("/admin/curators", req);
    errorUrl.searchParams.set("error", "Kurator ma'lumotlari to'liq emas");
    return NextResponse.redirect(errorUrl, 303);
  }

  if (!isUzE164(phone)) {
    const errorUrl = buildUrl("/admin/curators", req);
    errorUrl.searchParams.set("error", "Telefon +998XXXXXXXXX formatda bo'lishi kerak");
    return NextResponse.redirect(errorUrl, 303);
  }

  if (toMinutes(workStart) >= toMinutes(workEnd)) {
    const errorUrl = buildUrl("/admin/curators", req);
    errorUrl.searchParams.set("error", "Ish vaqti noto'g'ri: boshlanish tugashdan oldin bo'lishi kerak");
    return NextResponse.redirect(errorUrl, 303);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const curator = await prisma.user.create({
      data: {
        role: "CURATOR",
        phone,
        passwordHash,
        curatorProfile: {
          create: {
            fullName,
            isSuspended: false,
            workStart,
            workEnd,
            workDays,
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "CREATE",
        entity: "Curator",
        entityId: curator.id,
      },
    });
  } catch {
    const errorUrl = buildUrl("/admin/curators", req);
    errorUrl.searchParams.set("error", "Kurator yaratilmadi. Telefon band bo'lishi mumkin");
    return NextResponse.redirect(errorUrl, 303);
  }

  const okUrl = buildUrl("/admin/curators", req);
  okUrl.searchParams.set("msg", "Kurator yaratildi");
  return NextResponse.redirect(okUrl, 303);
}

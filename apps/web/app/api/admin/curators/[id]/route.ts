import bcrypt from "bcryptjs";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { formatCuratorWorkDays, normalizeDays, parseCuratorWorkDays } from "@/lib/group-schedule";
import { isUzE164, normalizeUzPhone } from "@/lib/phone";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "true" || v === "1" || v === "active") return true;
  if (v === "false" || v === "0" || v === "inactive") return false;
  return null;
}

function normalizeClock(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function extractRange(raw: string): { start: string | null; end: string | null } {
  const range = raw.match(/(\d{1,2}:[0-5]\d)\s*-\s*(\d{1,2}:[0-5]\d)/);
  if (!range) return { start: null, end: null };
  return {
    start: normalizeClock(range[1]),
    end: normalizeClock(range[2]),
  };
}

function toMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function redirectCurators(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/curators", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function updateCurator(
  req: Request,
  curatorId: string,
  payload: {
    isActive?: string;
    fullName?: string;
    phone?: string;
    password?: string;
    workStart?: string;
    workEnd?: string;
    workDays?: string;
  },
  asJson: boolean,
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const curator = await prisma.user.findFirst({
    where: { id: curatorId, role: "CURATOR" },
    include: {
      curatorProfile: true,
      catalogGroups: {
        select: {
          id: true,
          code: true,
          days: true,
          time: true,
          scheduleText: true,
          status: true,
        },
      },
    },
  });
  if (!curator || !curator.curatorProfile) {
    if (asJson) return NextResponse.json({ ok: false, error: "Kurator topilmadi" }, { status: 404 });
    return redirectCurators(req, "Kurator topilmadi", true);
  }

  const nextFullName = payload.fullName?.trim() ? payload.fullName.trim() : curator.curatorProfile.fullName;
  const nextPhone = payload.phone !== undefined ? normalizeUzPhone(payload.phone) : curator.phone;

  if (!nextPhone || !isUzE164(nextPhone)) {
    if (asJson) return NextResponse.json({ ok: false, error: "Telefon +998XXXXXXXXX formatda bo'lishi kerak" }, { status: 400 });
    return redirectCurators(req, "Telefon +998XXXXXXXXX formatda bo'lishi kerak", true);
  }

  const parsedActive = payload.isActive !== undefined ? parseBool(payload.isActive) : null;
  if (payload.isActive !== undefined && parsedActive === null) {
    if (asJson) return NextResponse.json({ ok: false, error: "isActive noto'g'ri" }, { status: 400 });
    return redirectCurators(req, "isActive noto'g'ri", true);
  }

  const workStartInput = payload.workStart !== undefined ? normalizeClock(payload.workStart) : curator.curatorProfile.workStart;
  const workEndInput = payload.workEnd !== undefined ? normalizeClock(payload.workEnd) : curator.curatorProfile.workEnd;
  const workDaysInput =
    payload.workDays !== undefined
      ? parseCuratorWorkDays(payload.workDays)
      : parseCuratorWorkDays(curator.curatorProfile.workDays ?? "HAR_KUNI");

  if (!workStartInput || !workEndInput || !workDaysInput) {
    if (asJson) return NextResponse.json({ ok: false, error: "Kurator ish vaqti to'liq bo'lishi kerak" }, { status: 400 });
    return redirectCurators(req, "Kurator ish vaqti to'liq bo'lishi kerak", true);
  }

  if (toMinutes(workStartInput) >= toMinutes(workEndInput)) {
    if (asJson) {
      return NextResponse.json(
        { ok: false, error: "Ish vaqti noto'g'ri: boshlanish tugashdan oldin bo'lishi kerak" },
        { status: 400 },
      );
    }
    return redirectCurators(req, "Ish vaqti noto'g'ri: boshlanish tugashdan oldin bo'lishi kerak", true);
  }

  const invalidByWorkTime = curator.catalogGroups.find((group) => {
    if (group.status === "YOPIQ") return false;
    const range = extractRange(group.time ?? group.scheduleText);
    if (!range.start || !range.end) return false;
    return toMinutes(range.start) < toMinutes(workStartInput) || toMinutes(range.end) > toMinutes(workEndInput);
  });

  if (invalidByWorkTime) {
    if (asJson) {
      return NextResponse.json(
        { ok: false, error: `Ish vaqti ${invalidByWorkTime.code} guruhi jadvaliga mos emas` },
        { status: 400 },
      );
    }
    return redirectCurators(req, `Ish vaqti ${invalidByWorkTime.code} guruhi jadvaliga mos emas`, true);
  }

  const invalidByWorkDay = curator.catalogGroups.find((group) => {
    if (group.status === "YOPIQ") return false;
    if (workDaysInput === "HAR_KUNI") return false;
    const groupDays = normalizeDays(group.days ?? group.scheduleText);
    if (!groupDays) return false;
    return groupDays !== workDaysInput;
  });

  if (invalidByWorkDay) {
    if (asJson) {
      return NextResponse.json(
        {
          ok: false,
          error: `Ish kuni ${invalidByWorkDay.code} guruhi bilan mos emas. Tanlangan: ${formatCuratorWorkDays(workDaysInput)}`,
        },
        { status: 400 },
      );
    }
    return redirectCurators(
      req,
      `Ish kuni ${invalidByWorkDay.code} guruhi bilan mos emas. Tanlangan: ${formatCuratorWorkDays(workDaysInput)}`,
      true,
    );
  }

  const password = payload.password?.trim() ?? "";
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: curator.id },
        data: {
          phone: nextPhone,
          ...(passwordHash ? { passwordHash } : {}),
          ...(parsedActive !== null ? { isActive: parsedActive } : {}),
        },
      });

      await tx.curatorProfile.update({
        where: { userId: curator.id },
        data: {
          fullName: nextFullName,
          workStart: workStartInput,
          workEnd: workEndInput,
          workDays: workDaysInput,
          ...(parsedActive !== null ? { isSuspended: !parsedActive } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "UPDATE",
          entity: "Curator",
          entityId: curator.id,
          payload: {
            isActive: parsedActive,
            phone: nextPhone,
            fullName: nextFullName,
            workStart: workStartInput,
            workEnd: workEndInput,
            workDays: workDaysInput,
            passwordChanged: Boolean(passwordHash),
          },
        },
      });
    });
  } catch (error) {
    console.error("ADMIN_CURATOR_UPDATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Kurator yangilanmadi" }, { status: 500 });
    return redirectCurators(req, "Kurator yangilanmadi (telefon band bo'lishi mumkin)", true);
  }

  if (asJson) return NextResponse.json({ ok: true });
  return redirectCurators(req, "Kurator yangilandi");
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const data = (await req.json()) as {
    isActive?: string;
    fullName?: string;
    phone?: string;
    password?: string;
    workStart?: string;
    workEnd?: string;
    workDays?: string;
  };

  return updateCurator(req, id, data, true);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const method = String(form.get("_method") ?? "").toUpperCase();
  if (method !== "PATCH") return new NextResponse("Method Not Allowed", { status: 405 });

  return updateCurator(
    req,
    id,
    {
      isActive: String(form.get("isActive") ?? ""),
      fullName: String(form.get("fullName") ?? ""),
      phone: String(form.get("phone") ?? ""),
      password: String(form.get("password") ?? ""),
      workStart: String(form.get("workStart") ?? ""),
      workEnd: String(form.get("workEnd") ?? ""),
      workDays: String(form.get("workDays") ?? ""),
    },
    isJson(req),
  );
}

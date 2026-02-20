import { GroupCatalogFormat, GroupCatalogStatus } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import {
  extractRange,
  formatDays,
  normalizeClock,
  normalizeDays,
  toMinutes,
  validateCuratorTimeConstraints,
} from "@/lib/group-schedule";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

type GroupFan = "Kimyo" | "Biologiya";

function parseStatus(value: string): GroupCatalogStatus {
  if (value === "OCHIQ") return GroupCatalogStatus.OCHIQ;
  if (value === "BOSHLANGAN") return GroupCatalogStatus.BOSHLANGAN;
  if (value === "YOPIQ") return GroupCatalogStatus.YOPIQ;
  return GroupCatalogStatus.REJADA;
}

function parseFormat(value: string): GroupCatalogFormat {
  if (value === "OFFLINE") return GroupCatalogFormat.OFFLINE;
  return GroupCatalogFormat.ONLINE;
}

function normalizeFan(value: string): GroupFan | null {
  const raw = value.trim().toLowerCase();
  if (raw === "kimyo") return "Kimyo";
  if (raw === "biologiya") return "Biologiya";
  return null;
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function redirectAdmin(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/groups", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function readInput(req: Request): Promise<Record<string, string>> {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  if (json) {
    const data = (await req.json()) as Record<string, unknown>;
    return {
      code: String(data.code ?? ""),
      fan: String(data.fan ?? ""),
      scheduleText: String(data.scheduleText ?? ""),
      days: String(data.days ?? ""),
      startTime: String(data.startTime ?? ""),
      endTime: String(data.endTime ?? ""),
      time: String(data.time ?? ""),
      format: String(data.format ?? "ONLINE"),
      capacity: String(data.capacity ?? "0"),
      priceMonthly: String(data.priceMonthly ?? "0"),
      status: String(data.status ?? "REJADA"),
      curatorId: String(data.curatorId ?? ""),
    };
  }

  const form = await req.formData();
  return {
    code: String(form.get("code") ?? ""),
    fan: String(form.get("fan") ?? ""),
    scheduleText: String(form.get("scheduleText") ?? ""),
    days: String(form.get("days") ?? ""),
    startTime: String(form.get("startTime") ?? ""),
    endTime: String(form.get("endTime") ?? ""),
    time: String(form.get("time") ?? ""),
    format: String(form.get("format") ?? "ONLINE"),
    capacity: String(form.get("capacity") ?? "0"),
    priceMonthly: String(form.get("priceMonthly") ?? "0"),
    status: String(form.get("status") ?? "REJADA"),
    curatorId: String(form.get("curatorId") ?? ""),
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const asJson = isJson(req);
  const input = await readInput(req);

  const code = input.code.trim().toUpperCase();
  const fan = normalizeFan(input.fan);
  let daysParsed = normalizeDays(input.days);
  if (!daysParsed) daysParsed = normalizeDays(input.scheduleText);
  let startTime = normalizeClock(input.startTime);
  let endTime = normalizeClock(input.endTime);
  const fallbackRange = extractRange(input.time || input.scheduleText);
  if (!startTime) startTime = fallbackRange.start;
  if (!endTime) endTime = fallbackRange.end;
  const format = parseFormat(input.format);
  const status = parseStatus(input.status);
  const capacity = Number(input.capacity);
  const priceMonthly = Number(input.priceMonthly);
  const curatorId = input.curatorId.trim() || null;

  if (!fan) {
    if (asJson) return NextResponse.json({ ok: false, error: "Fan faqat Kimyo yoki Biologiya bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Fan faqat Kimyo yoki Biologiya bo'lishi kerak", true);
  }

  if (
    !code ||
    !daysParsed ||
    !startTime ||
    !endTime ||
    toMinutes(startTime) >= toMinutes(endTime) ||
    !Number.isFinite(capacity) ||
    capacity < 1 ||
    !Number.isFinite(priceMonthly) ||
    priceMonthly < 0
  ) {
    if (asJson) return NextResponse.json({ ok: false, error: "Group maydonlari noto'g'ri" }, { status: 400 });
    return redirectAdmin(req, "Group maydonlari noto'g'ri", true);
  }

  const validation = await validateCuratorTimeConstraints({
    curatorId,
    days: daysParsed,
    startTime,
    endTime,
  });

  if (!validation.ok) {
    if (asJson) return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    return redirectAdmin(req, validation.error, true);
  }

  const days = daysParsed;
  const time = `${startTime}-${endTime}`;
  const scheduleText = `${formatDays(days)} ${time}`;

  try {
    const group = await prisma.groupCatalog.create({
      data: {
        code,
        fan,
        scheduleText,
        days,
        time,
        format,
        capacity,
        priceMonthly,
        status,
        curatorId,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "CREATE",
        entity: "GroupCatalog",
        entityId: group.id,
        payload: { code, curatorId },
      },
    });

    if (asJson) return NextResponse.json({ ok: true, group });
    return redirectAdmin(req, "Group yaratildi");
  } catch (error) {
    console.error("ADMIN_GROUP_CREATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Group yaratilmadi" }, { status: 500 });
    return redirectAdmin(req, "Group yaratilmadi (code band bo'lishi mumkin)", true);
  }
}

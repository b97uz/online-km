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

function redirectAdmin(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/groups", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

async function updateGroup(
  req: Request,
  id: string,
  input: {
    code?: string;
    fan?: string;
    scheduleText?: string;
    days?: string;
    startTime?: string;
    endTime?: string;
    time?: string;
    format?: string;
    capacity?: string;
    priceMonthly?: string;
    status?: string;
    curatorId?: string;
  },
  asJson: boolean,
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const group = await prisma.groupCatalog.findUnique({ where: { id } });
  if (!group) {
    if (asJson) return NextResponse.json({ ok: false, error: "Group topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Group topilmadi", true);
  }

  const code = input.code?.trim() ? input.code.trim().toUpperCase() : group.code;
  const fan = input.fan !== undefined ? normalizeFan(input.fan) : normalizeFan(group.fan);

  const currentDays = normalizeDays(group.days ?? group.scheduleText);
  const currentRange = extractRange(group.time ?? group.scheduleText);

  const daysParsed = input.days !== undefined ? normalizeDays(input.days) : currentDays;

  let startTime = input.startTime !== undefined ? normalizeClock(input.startTime) : currentRange.start;
  let endTime = input.endTime !== undefined ? normalizeClock(input.endTime) : currentRange.end;

  if ((!startTime || !endTime) && input.time !== undefined) {
    const fromTime = extractRange(input.time);
    if (!startTime) startTime = fromTime.start;
    if (!endTime) endTime = fromTime.end;
  }

  if ((!startTime || !endTime) && input.scheduleText !== undefined) {
    const fromSchedule = extractRange(input.scheduleText);
    if (!startTime) startTime = fromSchedule.start;
    if (!endTime) endTime = fromSchedule.end;
  }

  const format = input.format ? parseFormat(input.format) : group.format;
  const status = input.status ? parseStatus(input.status) : group.status;
  const capacity = input.capacity !== undefined ? Number(input.capacity) : group.capacity;
  const priceMonthly = input.priceMonthly !== undefined ? Number(input.priceMonthly) : group.priceMonthly;
  const curatorId = input.curatorId !== undefined ? input.curatorId.trim() || null : group.curatorId;

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

  if (!fan) {
    if (asJson) return NextResponse.json({ ok: false, error: "Fan faqat Kimyo yoki Biologiya bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Fan faqat Kimyo yoki Biologiya bo'lishi kerak", true);
  }

  const validation = await validateCuratorTimeConstraints({
    curatorId,
    days: daysParsed,
    startTime,
    endTime,
    excludeGroupId: group.id,
  });

  if (!validation.ok) {
    if (asJson) return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    return redirectAdmin(req, validation.error, true);
  }

  const days = daysParsed;
  const time = `${startTime}-${endTime}`;
  const scheduleText = `${formatDays(days)} ${time}`;

  try {
    const updated = await prisma.groupCatalog.update({
      where: { id: group.id },
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
        action: "UPDATE",
        entity: "GroupCatalog",
        entityId: updated.id,
        payload: { code, curatorId, status },
      },
    });

    if (asJson) return NextResponse.json({ ok: true, group: updated });
    return redirectAdmin(req, "Group yangilandi");
  } catch (error) {
    console.error("ADMIN_GROUP_UPDATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Group yangilanmadi" }, { status: 500 });
    return redirectAdmin(req, "Group yangilanmadi (code band bo'lishi mumkin)", true);
  }
}

async function deleteGroup(req: Request, id: string, asJson: boolean) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const group = await prisma.groupCatalog.findUnique({ where: { id }, select: { id: true, code: true } });
  if (!group) {
    if (asJson) return NextResponse.json({ ok: false, error: "Group topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Group topilmadi", true);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.groupCatalog.delete({ where: { id: group.id } });
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "DELETE",
          entity: "GroupCatalog",
          entityId: group.id,
          payload: { code: group.code },
        },
      });
    });

    if (asJson) return NextResponse.json({ ok: true });
    return redirectAdmin(req, "Group o'chirildi");
  } catch (error) {
    console.error("ADMIN_GROUP_DELETE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Group o'chirilmadi" }, { status: 500 });
    return redirectAdmin(req, "Group o'chirilmadi", true);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const data = (await req.json()) as {
    code?: string;
    fan?: string;
    scheduleText?: string;
    days?: string;
    startTime?: string;
    endTime?: string;
    time?: string;
    format?: string;
    capacity?: string;
    priceMonthly?: string;
    status?: string;
    curatorId?: string;
  };

  return updateGroup(req, id, data, true);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deleteGroup(req, id, isJson(req));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const method = String(form.get("_method") ?? "").toUpperCase();
  if (method === "PATCH") {
    const read = (key: string) => (form.has(key) ? String(form.get(key) ?? "") : undefined);

    return updateGroup(
      req,
      id,
      {
        code: read("code"),
        fan: read("fan"),
        scheduleText: read("scheduleText"),
        days: read("days"),
        startTime: read("startTime"),
        endTime: read("endTime"),
        time: read("time"),
        format: read("format"),
        capacity: read("capacity"),
        priceMonthly: read("priceMonthly"),
        status: read("status"),
        curatorId: read("curatorId"),
      },
      false,
    );
  }

  if (method === "DELETE") {
    return deleteGroup(req, id, false);
  }

  return new NextResponse("Method Not Allowed", { status: 405 });
}

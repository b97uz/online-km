import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import {
  canAccessGroupForJournal,
  monthKeyFromDate,
  parseDateOnlyUtc,
  startOfTodayUtc,
} from "@/lib/group-journal";
import { buildUrl } from "@/lib/url";
import { NextResponse } from "next/server";

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function getRedirectPath(raw: string, role: "ADMIN" | "CURATOR"): string {
  const path = raw.trim();
  if (path.startsWith("/admin/groups/") || path.startsWith("/curator/groups/")) return path;
  return role === "ADMIN" ? "/admin/groups" : "/curator/groups";
}

function redirectTo(req: Request, path: string, message: string, isError = false) {
  const url = buildUrl(path, req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function readInput(req: Request): Promise<Record<string, string>> {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  if (json) {
    const body = (await req.json()) as Record<string, unknown>;
    return {
      groupId: String(body.groupId ?? ""),
      journalDate: String(body.journalDate ?? ""),
      redirectTo: String(body.redirectTo ?? ""),
    };
  }

  const form = await req.formData();
  return {
    groupId: String(form.get("groupId") ?? ""),
    journalDate: String(form.get("journalDate") ?? ""),
    redirectTo: String(form.get("redirectTo") ?? ""),
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || (session.role !== "ADMIN" && session.role !== "CURATOR")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const asJson = isJson(req);
  const input = await readInput(req);
  const groupId = input.groupId.trim();
  const journalDate = parseDateOnlyUtc(input.journalDate);
  const redirectPath = getRedirectPath(input.redirectTo, session.role);

  if (!groupId || !journalDate) {
    if (asJson) {
      return NextResponse.json({ ok: false, error: "groupId va sana (YYYY-MM-DD) kerak" }, { status: 400 });
    }
    return redirectTo(req, redirectPath, "groupId va sana (YYYY-MM-DD) kerak", true);
  }

  const allowed = await canAccessGroupForJournal(session, groupId);
  if (!allowed) {
    if (asJson) return NextResponse.json({ ok: false, error: "Bu guruhga dostup yo'q" }, { status: 403 });
    return redirectTo(req, redirectPath, "Bu guruhga dostup yo'q", true);
  }

  const today = startOfTodayUtc();
  if (journalDate.getTime() < today.getTime()) {
    if (asJson) {
      return NextResponse.json({ ok: false, error: "O'tgan sanani qo'shib bo'lmaydi" }, { status: 400 });
    }
    return redirectTo(req, redirectPath, "O'tgan sanani qo'shib bo'lmaydi", true);
  }

  const existing = await prisma.groupJournalDate.findUnique({
    where: {
      groupId_journalDate: {
        groupId,
        journalDate,
      },
    },
    select: { id: true },
  });

  if (existing) {
    if (asJson) return NextResponse.json({ ok: true, alreadyExists: true, id: existing.id });
    return redirectTo(req, redirectPath, "Bu sana allaqachon qo'shilgan");
  }

  try {
    const created = await prisma.groupJournalDate.create({
      data: {
        groupId,
        journalDate,
        monthKey: monthKeyFromDate(journalDate),
        createdById: session.userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "CREATE",
        entity: "GroupJournalDate",
        entityId: created.id,
        payload: {
          groupId,
          journalDate,
        },
      },
    });

    if (asJson) return NextResponse.json({ ok: true, date: created });
    return redirectTo(req, redirectPath, "Sana qo'shildi");
  } catch (error) {
    console.error("GROUP_JOURNAL_DATE_CREATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Sana qo'shilmadi" }, { status: 500 });
    return redirectTo(req, redirectPath, "Sana qo'shilmadi", true);
  }
}

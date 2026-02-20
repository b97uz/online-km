import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { buildUrl } from "@/lib/url";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "CURATOR") return new NextResponse("Forbidden", { status: 403 });

  const groups = await prisma.groupCatalog.findMany({
    where: { curatorId: session.userId },
    include: {
      enrollments: {
        include: {
          student: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ ok: true, groups });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "CURATOR") return new NextResponse("Forbidden", { status: 403 });

  const url = buildUrl("/curator/groups", req);
  url.searchParams.set("error", "Guruhlar admin tomonidan yaratiladi va biriktiriladi");
  return NextResponse.redirect(url, 303);
}

import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { isPaymentTableMissingError } from "@/lib/payment-table";
import {
  getPaymentStatus,
  isValidMonth,
  parseNonNegativeInt,
  parsePaymentMethod,
  parseSubject,
} from "@/lib/payments";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function redirectAdmin(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/payments", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function deletePayment(req: Request, id: string, asJson: boolean) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const payment = await prisma.payment.findUnique({ where: { id }, select: { id: true, isDeleted: true } });
  if (!payment) {
    if (asJson) return NextResponse.json({ ok: false, error: "Payment topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Payment topilmadi", true);
  }

  if (payment.isDeleted) {
    if (asJson) return NextResponse.json({ ok: true });
    return redirectAdmin(req, "To'lov allaqachon o'chirilgan (arxivda)");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: session.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "DELETE",
          entity: "Payment",
          entityId: payment.id,
        },
      });
    });
  } catch (error) {
    if (isPaymentTableMissingError(error)) {
      if (asJson) return NextResponse.json({ ok: false, error: "Payments jadvali yo'q. Migratsiyani ishga tushiring." }, { status: 503 });
      return redirectAdmin(req, "Payments jadvali yo'q. `prisma migrate deploy` ni ishga tushiring.", true);
    }
    console.error("ADMIN_PAYMENT_DELETE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "To'lov o'chirilmadi" }, { status: 500 });
    return redirectAdmin(req, "To'lov o'chirilmadi", true);
  }

  if (asJson) return NextResponse.json({ ok: true });
  return redirectAdmin(req, "To'lov o'chirildi (arxivda qoldi)");
}

async function updatePayment(
  req: Request,
  paymentId: string,
  input: {
    subject?: string;
    month?: string;
    amountRequired?: string;
    amountPaid?: string;
    discount?: string;
    paymentMethod?: string;
    note?: string;
    paidAt?: string;
  },
  asJson: boolean,
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  let existing: Awaited<ReturnType<typeof prisma.payment.findUnique>>;
  try {
    existing = await prisma.payment.findUnique({ where: { id: paymentId } });
  } catch (error) {
    if (isPaymentTableMissingError(error)) {
      if (asJson) return NextResponse.json({ ok: false, error: "Payments jadvali yo'q. Migratsiyani ishga tushiring." }, { status: 503 });
      return redirectAdmin(req, "Payments jadvali yo'q. `prisma migrate deploy` ni ishga tushiring.", true);
    }
    throw error;
  }

  if (!existing) {
    if (asJson) return NextResponse.json({ ok: false, error: "Payment topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Payment topilmadi", true);
  }

  const subject = input.subject !== undefined ? parseSubject(input.subject.trim()) : existing.subject;
  const month = input.month !== undefined ? input.month.trim() : existing.month;
  const amountRequired = input.amountRequired !== undefined ? parseNonNegativeInt(input.amountRequired.trim()) : existing.amountRequired;
  const amountPaid = input.amountPaid !== undefined ? parseNonNegativeInt(input.amountPaid.trim()) : existing.amountPaid;
  const discount = input.discount !== undefined ? parseNonNegativeInt(input.discount.trim()) : existing.discount;
  const paymentMethod = input.paymentMethod !== undefined ? parsePaymentMethod(input.paymentMethod.trim()) : existing.paymentMethod;
  const note = input.note !== undefined ? input.note.trim() || null : existing.note;
  const paidAt = input.paidAt !== undefined ? new Date(input.paidAt.trim()) : existing.paidAt;

  if (!subject || !paymentMethod || !isValidMonth(month) || amountRequired === null || amountPaid === null || discount === null) {
    if (asJson) return NextResponse.json({ ok: false, error: "Payment maydonlari noto'g'ri" }, { status: 400 });
    return redirectAdmin(req, "Payment maydonlari noto'g'ri", true);
  }

  if (Number.isNaN(paidAt.getTime())) {
    if (asJson) return NextResponse.json({ ok: false, error: "paidAt noto'g'ri" }, { status: 400 });
    return redirectAdmin(req, "To'lov sanasi noto'g'ri", true);
  }

  const status = getPaymentStatus(amountRequired, discount, amountPaid);

  let updated: Awaited<ReturnType<typeof prisma.payment.update>>;
  try {
    updated = await prisma.payment.update({
      where: { id: existing.id },
      data: {
        subject,
        month,
        amountRequired,
        amountPaid,
        discount,
        paymentMethod,
        status,
        note,
        paidAt,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.userId,
        action: "UPDATE",
        entity: "Payment",
        entityId: updated.id,
        payload: { month, status, amountPaid, discount },
      },
    });
  } catch (error) {
    if (isPaymentTableMissingError(error)) {
      if (asJson) return NextResponse.json({ ok: false, error: "Payments jadvali yo'q. Migratsiyani ishga tushiring." }, { status: 503 });
      return redirectAdmin(req, "Payments jadvali yo'q. `prisma migrate deploy` ni ishga tushiring.", true);
    }
    console.error("ADMIN_PAYMENT_UPDATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "To'lov yangilanmadi" }, { status: 500 });
    return redirectAdmin(req, "To'lov yangilanmadi", true);
  }

  if (asJson) return NextResponse.json({ ok: true, payment: updated });
  return redirectAdmin(req, "To'lov yangilandi");
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const data = (await req.json()) as {
    subject?: string;
    month?: string;
    amountRequired?: string;
    amountPaid?: string;
    discount?: string;
    paymentMethod?: string;
    note?: string;
    paidAt?: string;
  };
  return updatePayment(req, id, data, true);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deletePayment(req, id, isJson(req));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();
  const method = String(form.get("_method") ?? "").toUpperCase();

  if (method === "PATCH") {
    return updatePayment(
      req,
      id,
      {
        subject: String(form.get("subject") ?? ""),
        month: String(form.get("month") ?? ""),
        amountRequired: String(form.get("amountRequired") ?? ""),
        amountPaid: String(form.get("amountPaid") ?? ""),
        discount: String(form.get("discount") ?? ""),
        paymentMethod: String(form.get("paymentMethod") ?? ""),
        note: String(form.get("note") ?? ""),
        paidAt: String(form.get("paidAt") ?? ""),
      },
      false,
    );
  }

  if (method === "DELETE") {
    return deletePayment(req, id, false);
  }

  return new NextResponse("Method Not Allowed", { status: 405 });
}

import { AvailabilityDays, InstitutionType, PersonType, Role, StudentStatus, Subjects } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { parseInstitutionType } from "@/lib/locations";
import { isUzE164, normalizeUzPhone, phoneVariants } from "@/lib/phone";
import { NextResponse } from "next/server";
import { buildUrl } from "@/lib/url";

function parseStudentStatus(value: string): StudentStatus {
  if (value === "PASSIVE") return StudentStatus.PAUSED;
  if (value === "PAUSED") return StudentStatus.PAUSED;
  if (value === "BLOCKED") return StudentStatus.BLOCKED;
  return StudentStatus.ACTIVE;
}

function parseSubjects(value: string): Subjects | null {
  if (value === "CHEMISTRY") return Subjects.CHEMISTRY;
  if (value === "BIOLOGY") return Subjects.BIOLOGY;
  if (value === "BOTH") return Subjects.BOTH;
  return null;
}

function parsePersonType(value: string): PersonType | null {
  if (value === "GRADE_6") return PersonType.GRADE_6;
  if (value === "GRADE_7") return PersonType.GRADE_7;
  if (value === "GRADE_8") return PersonType.GRADE_8;
  if (value === "GRADE_9") return PersonType.GRADE_9;
  if (value === "GRADE_10") return PersonType.GRADE_10;
  if (value === "GRADE_11") return PersonType.GRADE_11;
  if (value === "COURSE_1") return PersonType.COURSE_1;
  if (value === "COURSE_2") return PersonType.COURSE_2;
  if (value === "ABITURIYENT") return PersonType.ABITURIYENT;
  if (value === "TALABA") return PersonType.TALABA;
  if (value === "OQITUVCHI") return PersonType.OQITUVCHI;
  return null;
}

function parseAvailabilityDays(value: string): AvailabilityDays | null {
  if (value === "DU_CHOR_JU") return AvailabilityDays.DU_CHOR_JU;
  if (value === "SE_PAY_SHAN") return AvailabilityDays.SE_PAY_SHAN;
  if (value === "FARQI_YOQ") return AvailabilityDays.FARQI_YOQ;
  return null;
}

function parseLevel(value: string): number | null {
  if (!value) return null;
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > 4) return null;
  return level;
}

function redirectAdmin(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/students", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

function isJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

async function updateStudent(
  req: Request,
  id: string,
  payload: {
    status?: string;
    fullName?: string;
    phone?: string;
    parentPhone?: string;
    subjects?: string;
    chemistryLevel?: string;
    biologyLevel?: string;
    provinceId?: string;
    districtId?: string;
    institutionType?: string;
    institutionId?: string;
    personType?: string;
    availabilityDays?: string;
    availabilityTime?: string;
    note?: string;
  },
  asJson: boolean,
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const student = await prisma.student.findUnique({ where: { id }, include: { user: true } });
  if (!student) {
    if (asJson) return NextResponse.json({ ok: false, error: "Student topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Student topilmadi", true);
  }

  const hasProfilePayload =
    payload.fullName !== undefined ||
    payload.phone !== undefined ||
    payload.parentPhone !== undefined ||
    payload.subjects !== undefined ||
    payload.chemistryLevel !== undefined ||
    payload.biologyLevel !== undefined ||
    payload.provinceId !== undefined ||
    payload.districtId !== undefined ||
    payload.institutionType !== undefined ||
    payload.institutionId !== undefined ||
    payload.personType !== undefined ||
    payload.availabilityDays !== undefined ||
    payload.availabilityTime !== undefined;

  const statusProvided = payload.status !== undefined;
  const noteProvided = payload.note !== undefined;

  const nextStatus = statusProvided ? parseStudentStatus(payload.status ?? "") : student.status;
  const nextNote = noteProvided ? payload.note?.trim() || null : student.note;

  if (!hasProfilePayload && !statusProvided && !noteProvided) {
    if (asJson) return NextResponse.json({ ok: false, error: "Yangilash uchun maydon topilmadi" }, { status: 400 });
    return redirectAdmin(req, "Yangilash uchun maydon topilmadi", true);
  }

  if (!hasProfilePayload) {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.student.update({
          where: { id: student.id },
          data: {
            ...(statusProvided ? { status: nextStatus } : {}),
            ...(noteProvided ? { note: nextNote } : {}),
          },
        });

        if (student.userId && statusProvided) {
          await tx.user.update({
            where: { id: student.userId },
            data: {
              isActive: nextStatus === StudentStatus.ACTIVE,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            actorId: session.userId,
            action: "UPDATE",
            entity: "Student",
            entityId: student.id,
            payload: {
              ...(statusProvided ? { status: nextStatus } : {}),
              ...(noteProvided ? { note: nextNote } : {}),
            },
          },
        });

        return result;
      });

      if (asJson) return NextResponse.json({ ok: true, student: updated });
      return redirectAdmin(req, "Student yangilandi");
    } catch (error) {
      console.error("ADMIN_STUDENT_UPDATE_ERROR", error);
      if (asJson) return NextResponse.json({ ok: false, error: "Student yangilanmadi" }, { status: 500 });
      return redirectAdmin(req, "Student yangilanmadi", true);
    }
  }

  const nextFullName = payload.fullName?.trim() ? payload.fullName.trim() : student.fullName;

  const nextPhone = payload.phone !== undefined ? normalizeUzPhone(payload.phone) : student.phone;
  if (!nextPhone || !isUzE164(nextPhone)) {
    if (asJson) return NextResponse.json({ ok: false, error: "Telefon +998XXXXXXXXX formatda bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Telefon +998XXXXXXXXX formatda bo'lishi kerak", true);
  }

  let nextParentPhone = student.parentPhone;
  if (payload.parentPhone !== undefined) {
    const normalized = normalizeUzPhone(payload.parentPhone);
    if (normalized) {
      if (!isUzE164(normalized)) {
        if (asJson) return NextResponse.json({ ok: false, error: "Parent phone format xato" }, { status: 400 });
        return redirectAdmin(req, "Parent phone +998XXXXXXXXX formatda bo'lishi kerak", true);
      }
      nextParentPhone = normalized;
    } else {
      nextParentPhone = null;
    }
  }

  const nextSubjects = payload.subjects !== undefined ? parseSubjects(payload.subjects.trim()) : student.subjects;
  if (!nextSubjects) {
    if (asJson) return NextResponse.json({ ok: false, error: "Fan tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Fan tanlanishi shart", true);
  }

  const chemistryLevelRaw = payload.chemistryLevel !== undefined ? parseLevel(payload.chemistryLevel.trim()) : student.chemistryLevel;
  const biologyLevelRaw = payload.biologyLevel !== undefined ? parseLevel(payload.biologyLevel.trim()) : student.biologyLevel;
  const nextProvinceId = payload.provinceId !== undefined ? payload.provinceId.trim() || null : student.provinceId;
  const nextDistrictId = payload.districtId !== undefined ? payload.districtId.trim() || null : student.districtId;
  const nextInstitutionType =
    payload.institutionType !== undefined
      ? parseInstitutionType(payload.institutionType.trim())
      : student.institutionType;
  const nextInstitutionIdInput = payload.institutionId !== undefined ? payload.institutionId.trim() || null : student.institutionId;

  if (!nextProvinceId) {
    if (asJson) return NextResponse.json({ ok: false, error: "Viloyat tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Viloyat tanlanishi shart", true);
  }

  if (!nextDistrictId) {
    if (asJson) return NextResponse.json({ ok: false, error: "Tuman tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Tuman tanlanishi shart", true);
  }

  if (!nextInstitutionType) {
    if (asJson) return NextResponse.json({ ok: false, error: "Ta'lim muassasasi turi tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Ta'lim muassasasi turi tanlanishi shart", true);
  }

  const nextPersonType = payload.personType !== undefined ? parsePersonType(payload.personType.trim()) : student.personType;
  if (!nextPersonType) {
    if (asJson) return NextResponse.json({ ok: false, error: "Kimligi tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Kimligi tanlanishi shart", true);
  }

  const nextAvailabilityDays =
    payload.availabilityDays !== undefined ? parseAvailabilityDays(payload.availabilityDays.trim()) : student.availabilityDays;
  if (!nextAvailabilityDays) {
    if (asJson) return NextResponse.json({ ok: false, error: "Bo'sh kunlar tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Bo'sh kunlar tanlanishi shart", true);
  }

  const nextAvailabilityTime =
    payload.availabilityTime !== undefined ? payload.availabilityTime.trim() : (student.availabilityTime ?? "");
  if (!nextAvailabilityTime) {
    if (asJson) return NextResponse.json({ ok: false, error: "Bo'sh vaqt yozilishi shart" }, { status: 400 });
    return redirectAdmin(req, "Bo'sh vaqt yozilishi shart", true);
  }

  let chemistryLevel: number | null = null;
  let biologyLevel: number | null = null;
  let institutionId: string | null = null;
  let institutionName: string | null = null;

  if (nextSubjects === Subjects.CHEMISTRY) {
    if (!chemistryLevelRaw) {
      if (asJson) return NextResponse.json({ ok: false, error: "Kimyo darajasi (1..4) majburiy" }, { status: 400 });
      return redirectAdmin(req, "Kimyo darajasi (1..4) majburiy", true);
    }
    chemistryLevel = chemistryLevelRaw;
  }

  if (nextSubjects === Subjects.BIOLOGY) {
    if (!biologyLevelRaw) {
      if (asJson) return NextResponse.json({ ok: false, error: "Biologiya darajasi (1..4) majburiy" }, { status: 400 });
      return redirectAdmin(req, "Biologiya darajasi (1..4) majburiy", true);
    }
    biologyLevel = biologyLevelRaw;
  }

  if (nextSubjects === Subjects.BOTH) {
    if (!chemistryLevelRaw || !biologyLevelRaw) {
      if (asJson) {
        return NextResponse.json(
          { ok: false, error: "Kimyo/Biologiya tanlanganda ikkala daraja ham (1..4) majburiy" },
          { status: 400 },
        );
      }
      return redirectAdmin(req, "Kimyo/Biologiya tanlanganda ikkala daraja ham (1..4) majburiy", true);
    }
    chemistryLevel = chemistryLevelRaw;
    biologyLevel = biologyLevelRaw;
  }

  const district = await prisma.district.findUnique({
    where: { id: nextDistrictId },
    select: { id: true, provinceId: true },
  });

  if (!district || district.provinceId !== nextProvinceId) {
    if (asJson) return NextResponse.json({ ok: false, error: "Viloyat va tuman mos emas" }, { status: 400 });
    return redirectAdmin(req, "Viloyat va tuman mos emas", true);
  }

  if (nextInstitutionType === InstitutionType.OTHER) {
    institutionId = null;
    institutionName = null;
  } else {
    if (!nextInstitutionIdInput) {
      const message = nextInstitutionType === InstitutionType.SCHOOL ? "Maktab tanlanishi shart" : "Litsey/Kollej tanlanishi shart";
      if (asJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
      return redirectAdmin(req, message, true);
    }

    const institution = await prisma.institution.findUnique({
      where: { id: nextInstitutionIdInput },
      select: { id: true, districtId: true, type: true, name: true },
    });

    const expectedType = nextInstitutionType === InstitutionType.SCHOOL ? "SCHOOL" : "LYCEUM_COLLEGE";
    if (!institution || institution.districtId !== nextDistrictId || institution.type !== expectedType) {
      if (asJson) return NextResponse.json({ ok: false, error: "Tanlangan muassasa noto'g'ri" }, { status: 400 });
      return redirectAdmin(req, "Tanlangan muassasa noto'g'ri", true);
    }

    institutionId = institution.id;
    institutionName = institution.name;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const studentPhoneConflict = await tx.student.findFirst({
        where: {
          id: { not: student.id },
          OR: phoneVariants(nextPhone).map((phone) => ({ phone })),
        },
        select: { id: true },
      });
      if (studentPhoneConflict) throw new Error("STUDENT_PHONE_EXISTS");

      const userPhoneConflict = await tx.user.findFirst({
        where: student.userId
          ? {
              id: { not: student.userId },
              OR: phoneVariants(nextPhone).map((phone) => ({ phone })),
            }
          : {
              OR: phoneVariants(nextPhone).map((phone) => ({ phone })),
            },
      });
      if (userPhoneConflict && userPhoneConflict.role !== Role.STUDENT) throw new Error("PHONE_USED_BY_OTHER_ROLE");

      const result = await tx.student.update({
        where: { id: student.id },
        data: {
          fullName: nextFullName,
          phone: nextPhone,
          parentPhone: nextParentPhone,
          status: nextStatus,
          subjects: nextSubjects,
          chemistryLevel,
          biologyLevel,
          provinceId: nextProvinceId,
          districtId: nextDistrictId,
          institutionType: nextInstitutionType,
          institutionId,
          institutionName,
          personType: nextPersonType,
          availabilityDays: nextAvailabilityDays,
          availabilityTime: nextAvailabilityTime,
          note: nextNote,
        },
      });

      if (student.userId) {
        await tx.user.update({
          where: { id: student.userId },
          data: {
            phone: nextPhone,
            role: Role.STUDENT,
            isActive: nextStatus === StudentStatus.ACTIVE,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "UPDATE",
          entity: "Student",
          entityId: student.id,
          payload: {
            status: nextStatus,
            fullName: nextFullName,
            phone: nextPhone,
            parentPhone: nextParentPhone,
            subjects: nextSubjects,
            chemistryLevel,
            biologyLevel,
            provinceId: nextProvinceId,
            districtId: nextDistrictId,
            institutionType: nextInstitutionType,
            institutionId,
            institutionName,
            personType: nextPersonType,
            availabilityDays: nextAvailabilityDays,
            availabilityTime: nextAvailabilityTime,
          },
        },
      });

      return result;
    });

    if (asJson) return NextResponse.json({ ok: true, student: updated });
    return redirectAdmin(req, "Student yangilandi");
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";

    if (message === "STUDENT_PHONE_EXISTS") {
      if (asJson) return NextResponse.json({ ok: false, error: "Bu phone bilan student allaqachon bor" }, { status: 409 });
      return redirectAdmin(req, "Bu phone bilan student allaqachon bor", true);
    }

    if (message === "PHONE_USED_BY_OTHER_ROLE") {
      if (asJson) return NextResponse.json({ ok: false, error: "Bu telefon boshqa role uchun ishlatilgan" }, { status: 409 });
      return redirectAdmin(req, "Bu telefon boshqa role uchun ishlatilgan", true);
    }

    console.error("ADMIN_STUDENT_UPDATE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Student yangilanmadi" }, { status: 500 });
    return redirectAdmin(req, "Student yangilanmadi", true);
  }
}

async function deleteStudent(req: Request, id: string, asJson: boolean) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    if (asJson) return NextResponse.json({ ok: false, error: "Student topilmadi" }, { status: 404 });
    return redirectAdmin(req, "Student topilmadi", true);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.student.delete({ where: { id: student.id } });

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "DELETE",
          entity: "Student",
          entityId: student.id,
          payload: { phone: student.phone, fullName: student.fullName },
        },
      });
    });

    if (asJson) return NextResponse.json({ ok: true });
    return redirectAdmin(req, "Student o'chirildi");
  } catch (error) {
    console.error("ADMIN_STUDENT_DELETE_ERROR", error);
    if (asJson) return NextResponse.json({ ok: false, error: "Student o'chirilmadi" }, { status: 500 });
    return redirectAdmin(req, "Student o'chirilmadi", true);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const asJson = isJson(req);
  const data = (await req.json()) as {
    status?: string;
    fullName?: string;
    phone?: string;
    parentPhone?: string;
    subjects?: string;
    chemistryLevel?: string;
    biologyLevel?: string;
    provinceId?: string;
    districtId?: string;
    institutionType?: string;
    institutionId?: string;
    personType?: string;
    availabilityDays?: string;
    availabilityTime?: string;
    note?: string;
  };

  return updateStudent(req, id, data, asJson);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return deleteStudent(req, id, isJson(req));
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

    return updateStudent(
      req,
      id,
      {
        status: read("status"),
        fullName: read("fullName"),
        phone: read("phone"),
        parentPhone: read("parentPhone"),
        subjects: read("subjects"),
        chemistryLevel: read("chemistryLevel"),
        biologyLevel: read("biologyLevel"),
        provinceId: read("provinceId"),
        districtId: read("districtId"),
        institutionType: read("institutionType"),
        institutionId: read("institutionId"),
        personType: read("personType"),
        availabilityDays: read("availabilityDays"),
        availabilityTime: read("availabilityTime"),
        note: read("note"),
      },
      false,
    );
  }

  if (method === "DELETE") {
    return deleteStudent(req, id, false);
  }

  return new NextResponse("Method Not Allowed", { status: 405 });
}

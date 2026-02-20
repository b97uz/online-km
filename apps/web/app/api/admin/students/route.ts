import { AvailabilityDays, InstitutionType, PersonType, Role, StudentStatus, Subjects } from "@prisma/client";
import { prisma } from "@km/db";
import { getSession } from "@/lib/auth";
import { isUzE164, normalizeUzPhone, phoneVariants } from "@/lib/phone";
import { parseInstitutionType } from "@/lib/locations";
import { generateNextStudentId } from "@/lib/student-id";
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

function toBoolJson(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return ct.includes("application/json") || accept.includes("application/json");
}

function redirectAdmin(req: Request, message: string, isError = false) {
  const url = buildUrl("/admin/students", req);
  url.searchParams.set(isError ? "error" : "msg", message);
  return NextResponse.redirect(url, 303);
}

async function readInput(req: Request): Promise<Record<string, string>> {
  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");
  if (isJson) {
    const data = (await req.json()) as Record<string, unknown>;
    return {
      fullName: String(data.fullName ?? ""),
      phone: String(data.phone ?? ""),
      parentPhone: String(data.parentPhone ?? ""),
      status: String(data.status ?? "ACTIVE"),
      subjects: String(data.subjects ?? ""),
      chemistryLevel: String(data.chemistryLevel ?? ""),
      biologyLevel: String(data.biologyLevel ?? ""),
      provinceId: String(data.provinceId ?? ""),
      districtId: String(data.districtId ?? ""),
      institutionType: String(data.institutionType ?? ""),
      institutionId: String(data.institutionId ?? ""),
      personType: String(data.personType ?? ""),
      availabilityDays: String(data.availabilityDays ?? ""),
      availabilityTime: String(data.availabilityTime ?? ""),
      note: String(data.note ?? ""),
    };
  }

  const form = await req.formData();
  return {
    fullName: String(form.get("fullName") ?? ""),
    phone: String(form.get("phone") ?? ""),
    parentPhone: String(form.get("parentPhone") ?? ""),
    status: String(form.get("status") ?? "ACTIVE"),
    subjects: String(form.get("subjects") ?? ""),
    chemistryLevel: String(form.get("chemistryLevel") ?? ""),
    biologyLevel: String(form.get("biologyLevel") ?? ""),
    provinceId: String(form.get("provinceId") ?? ""),
    districtId: String(form.get("districtId") ?? ""),
    institutionType: String(form.get("institutionType") ?? ""),
    institutionId: String(form.get("institutionId") ?? ""),
    personType: String(form.get("personType") ?? ""),
    availabilityDays: String(form.get("availabilityDays") ?? ""),
    availabilityTime: String(form.get("availabilityTime") ?? ""),
    note: String(form.get("note") ?? ""),
  };
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const isJson = toBoolJson(req);
  const input = await readInput(req);

  const fullName = input.fullName.trim();
  const phone = normalizeUzPhone(input.phone);
  const parentPhoneRaw = normalizeUzPhone(input.parentPhone);
  const status = parseStudentStatus(input.status);
  const subjects = parseSubjects(input.subjects);
  const chemistryLevelRaw = parseLevel(input.chemistryLevel.trim());
  const biologyLevelRaw = parseLevel(input.biologyLevel.trim());
  const provinceId = input.provinceId.trim() || null;
  const districtId = input.districtId.trim() || null;
  const institutionType = parseInstitutionType(input.institutionType.trim());
  const institutionIdInput = input.institutionId.trim() || null;
  const personType = parsePersonType(input.personType.trim());
  const availabilityDays = parseAvailabilityDays(input.availabilityDays.trim());
  const availabilityTime = input.availabilityTime.trim();
  const note = input.note.trim() || null;

  if (!fullName || !phone) {
    if (isJson) return NextResponse.json({ ok: false, error: "fullName va phone majburiy" }, { status: 400 });
    return redirectAdmin(req, "fullName va phone majburiy", true);
  }

  if (!subjects) {
    if (isJson) return NextResponse.json({ ok: false, error: "Fan tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Fan tanlanishi shart", true);
  }

  if (!provinceId) {
    if (isJson) return NextResponse.json({ ok: false, error: "Viloyat tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Viloyat tanlanishi shart", true);
  }

  if (!districtId) {
    if (isJson) return NextResponse.json({ ok: false, error: "Tuman tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Tuman tanlanishi shart", true);
  }

  if (!institutionType) {
    if (isJson) return NextResponse.json({ ok: false, error: "Ta'lim muassasasi turi tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Ta'lim muassasasi turi tanlanishi shart", true);
  }

  if (!personType) {
    if (isJson) return NextResponse.json({ ok: false, error: "Kimligi tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Kimligi tanlanishi shart", true);
  }

  if (!availabilityDays) {
    if (isJson) return NextResponse.json({ ok: false, error: "Bo'sh kunlar tanlanishi shart" }, { status: 400 });
    return redirectAdmin(req, "Bo'sh kunlar tanlanishi shart", true);
  }

  if (!availabilityTime) {
    if (isJson) return NextResponse.json({ ok: false, error: "Bo'sh vaqt yozilishi shart" }, { status: 400 });
    return redirectAdmin(req, "Bo'sh vaqt yozilishi shart", true);
  }

  if (!isUzE164(phone)) {
    if (isJson) return NextResponse.json({ ok: false, error: "Phone +998XXXXXXXXX formatda bo'lishi kerak" }, { status: 400 });
    return redirectAdmin(req, "Telefon +998XXXXXXXXX formatda bo'lishi kerak", true);
  }

  let parentPhone: string | null = null;
  let chemistryLevel: number | null = null;
  let biologyLevel: number | null = null;
  let institutionId: string | null = null;
  let institutionName: string | null = null;

  if (parentPhoneRaw) {
    if (!isUzE164(parentPhoneRaw)) {
      if (isJson) return NextResponse.json({ ok: false, error: "Parent phone +998XXXXXXXXX formatda bo'lishi kerak" }, { status: 400 });
      return redirectAdmin(req, "Ota-ona raqami +998XXXXXXXXX formatda bo'lishi kerak", true);
    }
    parentPhone = parentPhoneRaw;
  }

  if (subjects === Subjects.CHEMISTRY) {
    if (!chemistryLevelRaw) {
      if (isJson) return NextResponse.json({ ok: false, error: "Kimyo darajasi (1..4) majburiy" }, { status: 400 });
      return redirectAdmin(req, "Kimyo darajasi (1..4) majburiy", true);
    }
    chemistryLevel = chemistryLevelRaw;
  }

  if (subjects === Subjects.BIOLOGY) {
    if (!biologyLevelRaw) {
      if (isJson) return NextResponse.json({ ok: false, error: "Biologiya darajasi (1..4) majburiy" }, { status: 400 });
      return redirectAdmin(req, "Biologiya darajasi (1..4) majburiy", true);
    }
    biologyLevel = biologyLevelRaw;
  }

  if (subjects === Subjects.BOTH) {
    if (!chemistryLevelRaw || !biologyLevelRaw) {
      if (isJson) {
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
    where: { id: districtId },
    select: { id: true, provinceId: true },
  });

  if (!district || district.provinceId !== provinceId) {
    if (isJson) return NextResponse.json({ ok: false, error: "Viloyat va tuman mos emas" }, { status: 400 });
    return redirectAdmin(req, "Viloyat va tuman mos emas", true);
  }

  if (institutionType === InstitutionType.OTHER) {
    institutionId = null;
    institutionName = null;
  } else {
    if (!institutionIdInput) {
      const message = institutionType === InstitutionType.SCHOOL ? "Maktab tanlanishi shart" : "Litsey/Kollej tanlanishi shart";
      if (isJson) return NextResponse.json({ ok: false, error: message }, { status: 400 });
      return redirectAdmin(req, message, true);
    }

    const institution = await prisma.institution.findUnique({
      where: { id: institutionIdInput },
      select: { id: true, districtId: true, type: true, name: true },
    });

    const expectedType = institutionType === InstitutionType.SCHOOL ? "SCHOOL" : "LYCEUM_COLLEGE";
    if (!institution || institution.districtId !== districtId || institution.type !== expectedType) {
      if (isJson) return NextResponse.json({ ok: false, error: "Tanlangan muassasa noto'g'ri" }, { status: 400 });
      return redirectAdmin(req, "Tanlangan muassasa noto'g'ri", true);
    }

    institutionId = institution.id;
    institutionName = institution.name;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const phoneOr = phoneVariants(phone).map((value) => ({ phone: value }));

      const existingStudent = await tx.student.findFirst({ where: { OR: phoneOr } });
      if (existingStudent) {
        throw new Error("STUDENT_PHONE_EXISTS");
      }

      const existingUser = await tx.user.findFirst({ where: { OR: phoneOr } });
      if (existingUser && existingUser.role !== Role.STUDENT) {
        throw new Error("PHONE_USED_BY_OTHER_ROLE");
      }

      const linkedUser = existingUser
        ? await tx.user.update({
            where: { id: existingUser.id },
            data: {
              role: Role.STUDENT,
              phone,
              isActive: status === StudentStatus.ACTIVE,
            },
          })
        : await tx.user.create({
            data: {
              role: Role.STUDENT,
              phone,
              isActive: status === StudentStatus.ACTIVE,
            },
          });

      const studentCode = await generateNextStudentId(tx);

      const student = await tx.student.create({
        data: {
          studentCode,
          fullName,
          phone,
          parentPhone,
          status,
          subjects,
          chemistryLevel,
          biologyLevel,
          provinceId,
          districtId,
          institutionType,
          institutionId,
          institutionName,
          personType,
          availabilityDays,
          availabilityTime,
          note,
          userId: linkedUser.id,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          action: "CREATE",
          entity: "Student",
          entityId: student.id,
          payload: {
            studentCode,
            phone,
            status,
            subjects,
            chemistryLevel,
            biologyLevel,
            provinceId,
            districtId,
            institutionType,
            institutionId,
            institutionName,
            personType,
            availabilityDays,
            availabilityTime,
          },
        },
      });

      return student;
    });

    if (isJson) return NextResponse.json({ ok: true, student: result });
    return redirectAdmin(req, "Student yaratildi");
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";

    if (message === "STUDENT_PHONE_EXISTS") {
      if (isJson) return NextResponse.json({ ok: false, error: "Bu phone bilan student allaqachon bor" }, { status: 409 });
      return redirectAdmin(req, "Bu phone bilan student allaqachon bor", true);
    }

    if (message === "PHONE_USED_BY_OTHER_ROLE") {
      if (isJson) return NextResponse.json({ ok: false, error: "Bu telefon boshqa role uchun ishlatilgan" }, { status: 409 });
      return redirectAdmin(req, "Bu telefon boshqa role uchun ishlatilgan", true);
    }

    if (message === "STUDENT_ID_SEQUENCE_ERROR") {
      if (isJson) return NextResponse.json({ ok: false, error: "Student_ID generatsiyada xatolik bo'ldi" }, { status: 500 });
      return redirectAdmin(req, "Student_ID generatsiyada xatolik bo'ldi", true);
    }

    if (message === "STUDENT_ID_LIMIT_REACHED") {
      if (isJson) return NextResponse.json({ ok: false, error: "Student_ID limiti tugagan (999999)" }, { status: 500 });
      return redirectAdmin(req, "Student_ID limiti tugagan (999999)", true);
    }

    console.error("ADMIN_STUDENT_CREATE_ERROR", error);
    if (isJson) return NextResponse.json({ ok: false, error: "Student yaratilmadi" }, { status: 500 });
    return redirectAdmin(req, "Student yaratilmadi", true);
  }
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return new NextResponse("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const phoneQuery = (url.searchParams.get("phone") ?? "").trim();
  const variants = phoneVariants(phoneQuery);
  const digitsOnly = phoneQuery.replace(/\D/g, "");

  const students = await prisma.student.findMany({
    where:
      phoneQuery && variants.length > 0
        ? {
            OR: [
              ...variants.map((value) => ({ phone: value })),
              { phone: { contains: digitsOnly } },
            ],
          }
        : phoneQuery
          ? { phone: { contains: phoneQuery } }
          : undefined,
    include: {
      province: {
        select: { id: true, name: true },
      },
      district: {
        select: { id: true, name: true, provinceId: true },
      },
      institution: {
        select: { id: true, name: true, districtId: true, type: true },
      },
      enrollments: {
        include: {
          group: {
            select: {
              id: true,
              code: true,
              fan: true,
              status: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ ok: true, students });
}

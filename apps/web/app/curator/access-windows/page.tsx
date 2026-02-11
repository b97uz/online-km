import { prisma } from "@km/db";
import { requireRole } from "@/lib/require-role";

type CuratorAccessWindowsParams = {
  msg?: string;
  error?: string;
};

function toDateTimeLocal(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("uz-UZ", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export default async function CuratorAccessWindowsPage({
  searchParams,
}: {
  searchParams: Promise<CuratorAccessWindowsParams>;
}) {
  const session = await requireRole("CURATOR");
  const params = await searchParams;

  const [assignedGroups, tests, windows] = await Promise.all([
    prisma.groupCatalog.findMany({
      where: { curatorId: session.userId },
      include: {
        enrollments: {
          where: {
            status: {
              in: ["TRIAL", "ACTIVE"],
            },
          },
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                phone: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.test.findMany({
      where: { isActive: true },
      include: {
        lesson: {
          include: { book: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.accessWindow.findMany({
      where: {
        createdBy: session.userId,
      },
      include: {
        student: {
          select: {
            id: true,
            phone: true,
          },
        },
        test: {
          include: {
            lesson: {
              include: {
                book: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);

  const uniqueStudents = Array.from(
    new Map(
      assignedGroups
        .flatMap((group) => group.enrollments)
        .map((enrollment) => [enrollment.student.id, enrollment.student]),
    ).values(),
  );

  const now = new Date();
  const defaultFrom = toDateTimeLocal(now);
  const defaultTo = toDateTimeLocal(new Date(now.getTime() + 2 * 60 * 60 * 1000));

  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">Access Window</h1>

      {params?.msg ? (
        <p className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">{params.msg}</p>
      ) : null}
      {params?.error ? (
        <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{params.error}</p>
      ) : null}

      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Talabaga test oynasi ochish</h2>
        <form action="/api/curator/access-windows" method="post" className="grid gap-2 md:max-w-2xl">
          <input
            name="studentPhone"
            className="rounded border p-2"
            placeholder="+998901234567"
            list="studentPhones"
            required
          />
          <datalist id="studentPhones">
            {uniqueStudents.map((student) => (
              <option key={student.id} value={student.phone}>
                {student.fullName}
              </option>
            ))}
          </datalist>

          <select name="testId" className="rounded border p-2" required>
            <option value="">Test tanlang</option>
            {tests.map((test) => (
              <option key={test.id} value={test.id}>
                {test.lesson.book.title} | {test.lesson.lessonNumber}-dars | ID: {test.id}
              </option>
            ))}
          </select>

          <input name="openFrom" type="datetime-local" className="rounded border p-2" defaultValue={defaultFrom} required />
          <input name="openTo" type="datetime-local" className="rounded border p-2" defaultValue={defaultTo} required />
          <button className="rounded bg-blue-600 p-2 text-white">Oynani ochish</button>
        </form>
      </section>

      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Yaratilgan oynalar</h2>
        <div className="overflow-auto">
          <table className="min-w-full border text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="border p-2 text-left">Student</th>
                <th className="border p-2 text-left">Test</th>
                <th className="border p-2 text-left">Oraliq</th>
                <th className="border p-2 text-left">Holat</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window) => (
                <tr key={window.id}>
                  <td className="border p-2">{window.student.phone ?? "-"}</td>
                  <td className="border p-2">
                    {window.test.lesson.book.title} | {window.test.lesson.lessonNumber}-dars
                  </td>
                  <td className="border p-2">
                    {formatDate(window.openFrom)} - {formatDate(window.openTo)}
                  </td>
                  <td className="border p-2">{window.isActive ? "ACTIVE" : "INACTIVE"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

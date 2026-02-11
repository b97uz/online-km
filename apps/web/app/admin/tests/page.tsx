import { prisma } from "@km/db";

type TestsPageParams = {
  msg?: string;
  error?: string;
};

export default async function AdminTestsPage({
  searchParams,
}: {
  searchParams: Promise<TestsPageParams>;
}) {
  const params = await searchParams;

  const [books, lessons] = await Promise.all([
    prisma.book.findMany({
      include: {
        _count: {
          select: {
            lessons: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.lesson.findMany({
      include: {
        book: true,
        _count: {
          select: {
            tests: true,
          },
        },
      },
      orderBy: [{ book: { title: "asc" } }, { lessonNumber: "asc" }],
      take: 1500,
    }),
  ]);

  const tests = await prisma.test.findMany({
    include: {
      lesson: {
        include: {
          book: true,
        },
      },
    },
    orderBy: [{ lesson: { book: { title: "asc" } } }, { lesson: { lessonNumber: "asc" } }, { createdAt: "desc" }],
    take: 2000,
  });

  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">Tests</h1>

      {params?.msg ? (
        <p className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">{params.msg}</p>
      ) : null}
      {params?.error ? (
        <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{params.error}</p>
      ) : null}

      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Kitob qo'shish</h2>
        <form action="/api/admin/books" method="post" className="grid gap-2 md:max-w-lg">
          <input name="title" className="rounded border p-2" placeholder="Kitob nomi" required />
          <button className="rounded bg-blue-600 p-2 text-white">Kitobni saqlash</button>
        </form>

        <div className="mt-4 overflow-auto">
          <table className="min-w-full border text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="border p-2 text-left">Kitob nomi</th>
                <th className="border p-2 text-left">Darslar soni</th>
                <th className="border p-2 text-left">Amal</th>
              </tr>
            </thead>
            <tbody>
              {books.map((book) => (
                <tr key={book.id}>
                  <td className="border p-2">{book.title}</td>
                  <td className="border p-2">{book._count.lessons}</td>
                  <td className="border p-2">
                    <form action={`/api/admin/books/${book.id}`} method="post">
                      <input type="hidden" name="_method" value="DELETE" />
                      <button className="rounded bg-red-600 px-3 py-1 text-white">Kitobni o'chirish</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Kitob + dars + test qo'shish</h2>
        <form action="/api/admin/tests" method="post" className="grid gap-2">
          <select name="bookId" className="rounded border p-2" defaultValue="" required>
            <option value="">Kitobni tanlang</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </select>
          <input name="lessonNumber" type="number" min={1} className="rounded border p-2" placeholder="Dars raqami (1..39)" required />
          <input name="lessonTitle" className="rounded border p-2" placeholder="Dars nomi" required />
          <input name="totalQuestions" type="number" min={1} className="rounded border p-2" placeholder="Savollar soni" required />
          <input
            name="answerKey"
            className="rounded border p-2"
            placeholder="A,B,C,D,... (savollar soniga teng)"
            required
          />
          <input
            name="imageUrl1"
            className="rounded border p-2"
            placeholder="1-bet rasm URL"
            required
          />
          <input
            name="imageUrl2"
            className="rounded border p-2"
            placeholder="2-bet rasm URL"
            required
          />
          <button className="rounded bg-blue-600 p-2 text-white">Testni saqlash</button>
        </form>
      </section>

      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Testlar ro'yxati</h2>
        <div className="overflow-auto">
          <table className="min-w-full border text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="border p-2 text-left">Kitob nomi</th>
                <th className="border p-2 text-left">Dars raqami</th>
                <th className="border p-2 text-left">Dars nomi</th>
                <th className="border p-2 text-left">Testlar soni</th>
              </tr>
            </thead>
            <tbody>
              {lessons.map((lesson) => (
                <tr key={lesson.id}>
                  <td className="border p-2">{lesson.book.title}</td>
                  <td className="border p-2">{lesson.lessonNumber}</td>
                  <td className="border p-2">{lesson.title}</td>
                  <td className="border p-2">{lesson._count.tests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded bg-white p-4 shadow">
        <h2 className="mb-2 text-lg font-semibold">Testni o'chirish</h2>
        <div className="overflow-auto">
          <table className="min-w-full border text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="border p-2 text-left">Kitob nomi</th>
                <th className="border p-2 text-left">Dars raqami</th>
                <th className="border p-2 text-left">Dars nomi</th>
                <th className="border p-2 text-left">Yaratilgan</th>
                <th className="border p-2 text-left">Amal</th>
              </tr>
            </thead>
            <tbody>
              {tests.map((test) => (
                <tr key={test.id}>
                  <td className="border p-2">{test.lesson.book.title}</td>
                  <td className="border p-2">{test.lesson.lessonNumber}</td>
                  <td className="border p-2">{test.lesson.title}</td>
                  <td className="border p-2">{new Date(test.createdAt).toLocaleString("uz-UZ")}</td>
                  <td className="border p-2">
                    <form action={`/api/admin/tests/${test.id}`} method="post">
                      <input type="hidden" name="_method" value="DELETE" />
                      <button className="rounded bg-red-600 px-3 py-1 text-white">Testni o'chirish</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

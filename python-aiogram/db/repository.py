from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from typing import Any, Optional
from uuid import uuid4

import asyncpg


ELIGIBLE_GROUP_STATUSES = ("REJADA", "OCHIQ", "BOSHLANGAN")
ELIGIBLE_ENROLLMENT_STATUSES = ("TRIAL", "ACTIVE")


@dataclass
class BotRepository:
    pool: asyncpg.Pool

    async def close(self) -> None:
        await self.pool.close()

    @staticmethod
    def _new_id() -> str:
        return uuid4().hex

    @staticmethod
    def _rows_affected(result: str) -> int:
        # asyncpg returns e.g. "UPDATE 1"
        try:
            return int(result.split()[-1])
        except Exception:
            return 0

    @staticmethod
    def _json_load(value: Any) -> Any:
        if isinstance(value, str):
            return json.loads(value)
        return value

    async def find_eligible_student_by_phone(self, variants: list[str]) -> Optional[dict]:
        if not variants:
            return None

        sql = """
        SELECT s.id, s."userId", s."fullName", s.phone, s."parentPhone", s.status
        FROM "Student" s
        WHERE s.status = 'ACTIVE'
          AND s.phone = ANY($1::text[])
          AND EXISTS (
              SELECT 1
              FROM "Enrollment" e
              JOIN "GroupCatalog" g ON g.id = e."groupId"
              WHERE e."studentId" = s.id
                AND e.status = ANY($2::"EnrollmentStatus"[])
                AND g.status = ANY($3::"GroupCatalogStatus"[])
          )
        LIMIT 1
        """

        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(sql, variants, list(ELIGIBLE_ENROLLMENT_STATUSES), list(ELIGIBLE_GROUP_STATUSES))
            if row:
                return {"personType": "STUDENT", "student": dict(row)}

            row = await conn.fetchrow(
                """
                SELECT s.id, s."userId", s."fullName", s.phone, s."parentPhone", s.status
                FROM "Student" s
                WHERE s.status = 'ACTIVE'
                  AND s."parentPhone" = ANY($1::text[])
                  AND EXISTS (
                      SELECT 1
                      FROM "Enrollment" e
                      JOIN "GroupCatalog" g ON g.id = e."groupId"
                      WHERE e."studentId" = s.id
                        AND e.status = ANY($2::"EnrollmentStatus"[])
                        AND g.status = ANY($3::"GroupCatalogStatus"[])
                  )
                ORDER BY s."createdAt" DESC
                LIMIT 1
                """,
                variants,
                list(ELIGIBLE_ENROLLMENT_STATUSES),
                list(ELIGIBLE_GROUP_STATUSES),
            )

            if row:
                return {"personType": "PARENT", "student": dict(row)}

        return None

    async def ensure_student_user_for_bot(self, student: dict, phone_variants: list[str]) -> str:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                existing_user = None
                if student.get("userId"):
                    existing_user = await conn.fetchrow(
                        'SELECT id, role FROM "User" WHERE id = $1',
                        student["userId"],
                    )
                if not existing_user:
                    existing_user = await conn.fetchrow(
                        'SELECT id, role FROM "User" WHERE phone = ANY($1::text[]) ORDER BY "createdAt" DESC LIMIT 1',
                        phone_variants,
                    )

                if existing_user and existing_user["role"] != "STUDENT":
                    raise ValueError("PHONE_USED_BY_OTHER_ROLE")

                active = student.get("status") == "ACTIVE"
                if existing_user:
                    user_id = existing_user["id"]
                    await conn.execute(
                        'UPDATE "User" SET role = $2, phone = $3, "isActive" = $4 WHERE id = $1',
                        user_id,
                        "STUDENT",
                        student["phone"],
                        active,
                    )
                else:
                    user_id = self._new_id()
                    await conn.execute(
                        'INSERT INTO "User" (id, role, phone, "isActive") VALUES ($1, $2, $3, $4)',
                        user_id,
                        "STUDENT",
                        student["phone"],
                        active,
                    )

                if student.get("userId") != user_id:
                    await conn.execute(
                        'UPDATE "Student" SET "userId" = $2 WHERE id = $1',
                        student["id"],
                        user_id,
                    )

                return user_id

    async def link_user_telegram(self, user_id: str, telegram_user_id: int) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                'UPDATE "User" SET "telegramUserId" = $2, "isActive" = true WHERE id = $1',
                user_id,
                str(telegram_user_id),
            )

    async def upsert_parent_contact(self, phone: str, telegram_user_id: int) -> None:
        tg = str(telegram_user_id)
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                by_phone = await conn.fetchrow('SELECT id FROM "ParentContact" WHERE phone = $1', phone)
                if by_phone:
                    await conn.execute(
                        'UPDATE "ParentContact" SET "telegramUserId" = $2, "updatedAt" = now() WHERE id = $1',
                        by_phone["id"],
                        tg,
                    )
                    return

                by_tg = await conn.fetchrow('SELECT id FROM "ParentContact" WHERE "telegramUserId" = $1', tg)
                if by_tg:
                    await conn.execute(
                        'UPDATE "ParentContact" SET phone = $2, "updatedAt" = now() WHERE id = $1',
                        by_tg["id"],
                        phone,
                    )
                    return

                await conn.execute(
                    'INSERT INTO "ParentContact" (id, phone, "telegramUserId", "updatedAt") VALUES ($1, $2, $3, now())',
                    self._new_id(),
                    phone,
                    tg,
                )

    async def resolve_actor_by_telegram_user_id(self, telegram_user_id: int) -> Optional[dict]:
        tg = str(telegram_user_id)
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT u.id AS user_id, s.id AS student_id, s."fullName", s.phone, s."parentPhone"
                FROM "User" u
                JOIN "Student" s ON s."userId" = u.id
                WHERE u."telegramUserId" = $1
                  AND u.role = 'STUDENT'
                  AND u."isActive" = true
                  AND s.status = 'ACTIVE'
                  AND EXISTS (
                    SELECT 1
                    FROM "Enrollment" e
                    JOIN "GroupCatalog" g ON g.id = e."groupId"
                    WHERE e."studentId" = s.id
                      AND e.status = ANY($2::"EnrollmentStatus"[])
                      AND g.status = ANY($3::"GroupCatalogStatus"[])
                  )
                LIMIT 1
                """,
                tg,
                list(ELIGIBLE_ENROLLMENT_STATUSES),
                list(ELIGIBLE_GROUP_STATUSES),
            )
            if row:
                return {
                    "type": "STUDENT",
                    "userId": row["user_id"],
                    "student": {
                        "id": row["student_id"],
                        "fullName": row["fullName"],
                        "phone": row["phone"],
                        "parentPhone": row["parentPhone"],
                    },
                }

            parent = await conn.fetchrow(
                'SELECT phone FROM "ParentContact" WHERE "telegramUserId" = $1',
                tg,
            )
            if not parent:
                return None

            phone = parent["phone"]
            variants = [phone, phone.lstrip("+")] if phone else []
            if not variants:
                return None

            row = await conn.fetchrow(
                """
                SELECT s.id AS student_id, s."userId", s."fullName", s.phone, s."parentPhone"
                FROM "Student" s
                WHERE s.status = 'ACTIVE'
                  AND s."parentPhone" = ANY($1::text[])
                  AND EXISTS (
                    SELECT 1
                    FROM "Enrollment" e
                    JOIN "GroupCatalog" g ON g.id = e."groupId"
                    WHERE e."studentId" = s.id
                      AND e.status = ANY($2::"EnrollmentStatus"[])
                      AND g.status = ANY($3::"GroupCatalogStatus"[])
                  )
                ORDER BY s."createdAt" DESC
                LIMIT 1
                """,
                variants,
                list(ELIGIBLE_ENROLLMENT_STATUSES),
                list(ELIGIBLE_GROUP_STATUSES),
            )

            if not row:
                return None

            return {
                "type": "PARENT",
                "student": {
                    "id": row["student_id"],
                    "userId": row["userId"],
                    "fullName": row["fullName"],
                    "phone": row["phone"],
                    "parentPhone": row["parentPhone"],
                },
            }

    async def get_active_window(self, student_user_id: str) -> Optional[dict]:
        now = datetime.utcnow()
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT
                  aw.id,
                  aw."studentId",
                  aw."testId",
                  aw."openFrom",
                  aw."openTo",
                  aw."openedAt",
                  aw."submittedAt",
                  aw."isActive",
                  t."totalQuestions",
                  t."answerKey",
                  t."telegramGroupLink",
                  l.id AS lesson_id,
                  l."lessonNumber",
                  l.title AS lesson_title,
                  b.id AS book_id,
                  b.title AS book_title
                FROM "AccessWindow" aw
                JOIN "Test" t ON t.id = aw."testId"
                JOIN "Lesson" l ON l.id = t."lessonId"
                JOIN "Book" b ON b.id = l."bookId"
                WHERE aw."studentId" = $1
                  AND aw."isActive" = true
                  AND aw."openFrom" <= $2
                  AND aw."openTo" >= $2
                  AND t."isActive" = true
                ORDER BY aw."openFrom" DESC
                LIMIT 1
                """,
                student_user_id,
                now,
            )
            if not row:
                return None

            images = await conn.fetch(
                'SELECT "imageUrl", "pageNumber" FROM "TestImage" WHERE "testId" = $1 ORDER BY "pageNumber" ASC',
                row["testId"],
            )

            return {
                "id": row["id"],
                "studentId": row["studentId"],
                "testId": row["testId"],
                "openFrom": row["openFrom"],
                "openTo": row["openTo"],
                "openedAt": row["openedAt"],
                "submittedAt": row["submittedAt"],
                "isActive": row["isActive"],
                "test": {
                    "id": row["testId"],
                    "totalQuestions": row["totalQuestions"],
                    "answerKey": self._json_load(row["answerKey"]),
                    "telegramGroupLink": row["telegramGroupLink"],
                    "lesson": {
                        "id": row["lesson_id"],
                        "lessonNumber": row["lessonNumber"],
                        "title": row["lesson_title"],
                        "book": {
                            "id": row["book_id"],
                            "title": row["book_title"],
                        },
                    },
                    "images": [
                        {
                            "imageUrl": item["imageUrl"],
                            "pageNumber": item["pageNumber"],
                        }
                        for item in images
                    ],
                },
            }

    async def mark_window_opened_once(self, window_id: str, now: datetime) -> bool:
        async with self.pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE "AccessWindow"
                SET "openedAt" = $2
                WHERE id = $1
                  AND "openedAt" IS NULL
                  AND "isActive" = true
                  AND "openFrom" <= $2
                  AND "openTo" >= $2
                """,
                window_id,
                now,
            )
            return self._rows_affected(result) > 0

    async def reset_window_opened(self, window_id: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                'UPDATE "AccessWindow" SET "openedAt" = NULL WHERE id = $1',
                window_id,
            )

    async def get_active_window_for_submit(
        self,
        window_id: str,
        student_user_id: str,
        test_id: str,
        now: datetime,
    ) -> Optional[dict]:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT aw.id, aw."testId", t."totalQuestions", t."answerKey"
                FROM "AccessWindow" aw
                JOIN "Test" t ON t.id = aw."testId"
                WHERE aw.id = $1
                  AND aw."studentId" = $2
                  AND aw."testId" = $3
                  AND aw."isActive" = true
                  AND aw."submittedAt" IS NULL
                  AND aw."openFrom" <= $4
                  AND aw."openTo" >= $4
                LIMIT 1
                """,
                window_id,
                student_user_id,
                test_id,
                now,
            )
            if not row:
                return None

            return {
                "id": row["id"],
                "test": {
                    "id": row["testId"],
                    "totalQuestions": row["totalQuestions"],
                    "answerKey": self._json_load(row["answerKey"]),
                },
            }

    async def lock_window_for_submission(
        self,
        window_id: str,
        student_user_id: str,
        test_id: str,
        submitted_at: datetime,
    ) -> bool:
        async with self.pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE "AccessWindow"
                SET "submittedAt" = $4,
                    "isActive" = false,
                    "openTo" = $4
                WHERE id = $1
                  AND "studentId" = $2
                  AND "testId" = $3
                  AND "isActive" = true
                  AND "submittedAt" IS NULL
                """,
                window_id,
                student_user_id,
                test_id,
                submitted_at,
            )
            return self._rows_affected(result) > 0

    async def create_submission_with_details(
        self,
        student_user_id: str,
        test_id: str,
        raw_answer_text: str,
        parsed_answers: list[str],
        score: int,
        details: list[dict],
    ) -> str:
        submission_id = self._new_id()
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO "Submission" (id, "studentId", "testId", "rawAnswerText", "parsedAnswers", score)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                    """,
                    submission_id,
                    student_user_id,
                    test_id,
                    raw_answer_text,
                    json.dumps(parsed_answers),
                    score,
                )

                rows = [
                    (
                        self._new_id(),
                        submission_id,
                        d["questionNumber"],
                        d["givenAnswer"],
                        d["correctAnswer"],
                        d["isCorrect"],
                    )
                    for d in details
                ]
                await conn.executemany(
                    """
                    INSERT INTO "SubmissionDetail"
                    (id, "submissionId", "questionNumber", "givenAnswer", "correctAnswer", "isCorrect")
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    rows,
                )

                await conn.execute(
                    """
                    INSERT INTO "AuditLog" (id, "actorId", action, entity, "entityId")
                    VALUES ($1, $2, 'SUBMIT', 'Submission', $3)
                    """,
                    self._new_id(),
                    student_user_id,
                    submission_id,
                )

        return submission_id

    async def create_appeal(
        self,
        student_id: str,
        sender_type: str,
        sender_telegram_user_id: int,
        sender_phone: str | None,
        text: str,
    ) -> str:
        appeal_id = self._new_id()
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO "Appeal"
                  (id, "studentId", "senderType", "senderTelegramUserId", "senderPhone", text, "updatedAt")
                VALUES
                  ($1, $2, $3, $4, $5, $6, now())
                """,
                appeal_id,
                student_id,
                sender_type,
                str(sender_telegram_user_id),
                sender_phone,
                text,
            )
        return appeal_id

    async def get_student_monthly_submissions(self, student_user_id: str, start: datetime, end: datetime) -> list[dict]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT s.id, s.score, s."createdAt", t."totalQuestions", l."lessonNumber", l.title AS lesson_title, b.title AS book_title
                FROM "Submission" s
                JOIN "Test" t ON t.id = s."testId"
                JOIN "Lesson" l ON l.id = t."lessonId"
                JOIN "Book" b ON b.id = l."bookId"
                WHERE s."studentId" = $1
                  AND s."createdAt" >= $2
                  AND s."createdAt" < $3
                ORDER BY s."createdAt" DESC
                LIMIT 50
                """,
                student_user_id,
                start,
                end,
            )
            return [dict(row) for row in rows]

    async def get_student_payments(self, student_registry_id: str) -> list[dict]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  p.id,
                  p."amountRequired",
                  p."amountPaid",
                  p.discount,
                  p.month,
                  p."periodEnd",
                  p."groupId",
                  p.status,
                  g.code AS group_code,
                  g.status AS group_status,
                  g."priceMonthly" AS group_price
                FROM "Payment" p
                LEFT JOIN "GroupCatalog" g ON g.id = p."groupId"
                WHERE p."studentId" = $1
                  AND p."isDeleted" = false
                ORDER BY p.month DESC, p."paidAt" DESC
                LIMIT 500
                """,
                student_registry_id,
            )
            return [dict(row) for row in rows]

    async def get_parent_recent_submissions(self, student_user_id: str) -> list[dict]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT s.id, s.score, s."createdAt", t."totalQuestions", l."lessonNumber", b.title AS book_title
                FROM "Submission" s
                JOIN "Test" t ON t.id = s."testId"
                JOIN "Lesson" l ON l.id = t."lessonId"
                JOIN "Book" b ON b.id = l."bookId"
                WHERE s."studentId" = $1
                ORDER BY s."createdAt" DESC
                LIMIT 10
                """,
                student_user_id,
            )
            return [dict(row) for row in rows]

    async def get_student_journal_rows(self, student_registry_id: str) -> list[dict]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                  e.id,
                  e.attendance,
                  e."theoryScore",
                  e."practicalScore",
                  e."updatedAt",
                  jd."journalDate",
                  g.code AS group_code,
                  l."lessonNumber",
                  l.title AS lesson_title,
                  b.title AS book_title
                FROM "GroupJournalEntry" e
                JOIN "GroupJournalDate" jd ON jd.id = e."journalDateId"
                JOIN "GroupCatalog" g ON g.id = jd."groupId"
                LEFT JOIN "Lesson" l ON l.id = e."lessonId"
                LEFT JOIN "Book" b ON b.id = l."bookId"
                WHERE e."studentId" = $1
                ORDER BY e."updatedAt" DESC
                LIMIT 10
                """,
                student_registry_id,
            )
            return [dict(row) for row in rows]

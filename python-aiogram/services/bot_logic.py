from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
from typing import Optional

from aiogram.types import (
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    ReplyKeyboardRemove,
)

from config import Settings
from db.repository import BotRepository
from services.answer_parser import ParseError, parse_answer_text
from services.constants import (
    PARENT_BTN_APPEAL,
    PARENT_BTN_DEBT,
    PARENT_BTN_RESULTS,
    PARENT_BUTTONS,
    REJECT_TEXT,
    STUDENT_BTN_APPEAL,
    STUDENT_BTN_PAY,
    STUDENT_BTN_RESULTS,
    STUDENT_BTN_TEST,
    STUDENT_BUTTONS,
)
from services.formatters import add_months_keeping_day, format_attendance, format_date, format_date_only, format_money
from services.keyboards import parent_menu_keyboard, phone_keyboard, student_menu_keyboard
from services.phone import normalize_uz_phone, phone_variants
from services.session_store import SessionStore
from services.types import SessionState


@dataclass
class BotLogic:
    repo: BotRepository
    settings: Settings
    sessions: SessionStore

    def _get_session(self, user_id: int) -> SessionState:
        return self.sessions.get(user_id)

    @staticmethod
    def _clear_session(session: SessionState) -> None:
        session.awaiting_phone = False
        session.awaiting_appeal = False
        session.active_test_id = None
        session.active_window_id = None
        session.sent_test_message_ids = []

    @staticmethod
    def _reset_to_phone(session: SessionState) -> None:
        session.awaiting_phone = True
        session.awaiting_appeal = False
        session.active_test_id = None
        session.active_window_id = None
        session.sent_test_message_ids = []

    def _resolve_image_url(self, image_url: str) -> str:
        if image_url.lower().startswith(("http://", "https://")):
            return image_url
        if image_url.startswith("/"):
            return f"{self.settings.web_base_url}{image_url}"
        return f"{self.settings.web_base_url}/{image_url}"

    def _resolve_local_image_path(self, image_url: str) -> Optional[Path]:
        raw = image_url.strip()
        rel = raw.lstrip("/")

        if raw.lower().startswith(("http://", "https://")):
            try:
                from urllib.parse import urlparse

                rel = urlparse(raw).path.lstrip("/")
            except Exception:
                return None

        if not rel:
            return None

        root = Path(__file__).resolve().parents[2]
        candidate1 = root / "apps" / "web" / "public" / rel
        if candidate1.exists():
            return candidate1

        candidate2 = Path.cwd() / "apps" / "web" / "public" / rel
        if candidate2.exists():
            return candidate2

        return None

    async def _send_test_image(self, message: Message, image_url: str) -> Optional[int]:
        local_path = self._resolve_local_image_path(image_url)
        if local_path:
            sent = await message.answer_photo(FSInputFile(str(local_path)), protect_content=True)
        else:
            sent = await message.answer_photo(self._resolve_image_url(image_url), protect_content=True)
        return sent.message_id if sent else None

    async def handle_start(self, message: Message) -> None:
        if not message.from_user:
            return

        actor = await self.repo.resolve_actor_by_telegram_user_id(message.from_user.id)
        session = self._get_session(message.from_user.id)

        if not actor:
            self._reset_to_phone(session)
            await message.answer(
                "Kelajakmediklari botiga xush kelibsiz. Telefon raqamingizni faqat pastdagi tugma orqali yuboring.",
                reply_markup=phone_keyboard(),
            )
            return

        self._clear_session(session)

        if actor["type"] == "STUDENT":
            await message.answer(
                f"Kelajakmediklari botiga xush kelibsiz, {actor['student']['fullName']}!",
                reply_markup=student_menu_keyboard(),
            )
            return

        await message.answer(
            f"Kelajakmediklari botiga xush kelibsiz!\nFarzandingiz: {actor['student']['fullName']}",
            reply_markup=parent_menu_keyboard(),
        )

    async def handle_ping(self, message: Message) -> None:
        await message.answer("Bot ishlayapti ✅")

    async def handle_contact(self, message: Message) -> None:
        if not message.from_user or not message.contact:
            return

        if not message.contact.user_id or message.contact.user_id != message.from_user.id:
            await message.answer("Iltimos, o'zingizning raqamingizni yuboring.")
            return

        session = self._get_session(message.from_user.id)
        variants = phone_variants(message.contact.phone_number)
        found = await self.repo.find_eligible_student_by_phone(variants)

        if not found:
            await message.answer(REJECT_TEXT, reply_markup=ReplyKeyboardRemove())
            return

        student = found["student"]

        try:
            if found["personType"] == "STUDENT":
                user_id = await self.repo.ensure_student_user_for_bot(student, phone_variants(student["phone"]))
                await self.repo.link_user_telegram(user_id, message.from_user.id)

                self._clear_session(session)
                await message.answer(
                    f"Kelajakmediklari botiga xush kelibsiz, {student['fullName']}!",
                    reply_markup=student_menu_keyboard(),
                )
                return

            parent_phone = normalize_uz_phone(student.get("parentPhone") or "")
            if not parent_phone:
                await message.answer("Ota-ona raqami topilmadi. Administratorga murojaat qiling.")
                return

            await self.repo.upsert_parent_contact(parent_phone, message.from_user.id)

            self._clear_session(session)
            await message.answer(
                f"Kelajakmediklari botiga xush kelibsiz!\nFarzandingiz: {student['fullName']}",
                reply_markup=parent_menu_keyboard(),
            )
        except ValueError as error:
            if str(error) == "PHONE_USED_BY_OTHER_ROLE":
                await message.answer("Telefon boshqa role bilan band. Administratorga murojaat qiling.")
                return
            raise
        except Exception as error:
            print("BOT_CONTACT_LINK_ERROR", error)
            await message.answer("Raqamni bog'lashda xatolik bo'ldi. Iltimos, qayta urinib ko'ring.")

    async def _student_debt_summary(self, student_registry_id: str) -> dict:
        rows = await self.repo.get_student_payments(student_registry_id)
        now = datetime.utcnow().date()

        latest_by_group: dict[str, dict] = {}
        total_base = 0

        for row in rows:
            base_debt = max(0, int(row["amountRequired"]) - int(row.get("discount") or 0) - int(row["amountPaid"]))
            total_base += base_debt

            group_id = row.get("groupId")
            period_end = row.get("periodEnd")
            if not group_id or not period_end:
                continue

            previous = latest_by_group.get(group_id)
            if not previous or previous["periodEnd"] < period_end:
                latest_by_group[group_id] = row

        total_extra = 0
        for latest in latest_by_group.values():
            group_status = latest.get("group_status")
            group_price = latest.get("group_price")
            period_end = latest.get("periodEnd")
            if group_status != "OCHIQ" or not group_price or not period_end:
                continue

            end_date = period_end.date()
            if now <= end_date:
                continue

            periods = 0
            cursor = end_date
            while cursor <= now:
                periods += 1
                cursor = add_months_keeping_day(end_date, periods)

            total_extra += periods * int(group_price)

        top_rows: list[dict] = []
        for row in rows[:10]:
            net = max(0, int(row["amountRequired"]) - int(row.get("discount") or 0))
            debt = max(0, net - int(row["amountPaid"]))
            top_rows.append(
                {
                    "month": row["month"],
                    "groupCode": row.get("group_code") or "-",
                    "net": net,
                    "paid": int(row["amountPaid"]),
                    "debt": debt,
                }
            )

        return {
            "totalDebt": total_base + total_extra,
            "totalBase": total_base,
            "totalExtra": total_extra,
            "topRows": top_rows,
        }

    async def _show_student_monthly_results(self, message: Message, actor: dict) -> None:
        now = datetime.now()
        start = datetime(now.year, now.month, 1)
        if now.month == 12:
            end = datetime(now.year + 1, 1, 1)
        else:
            end = datetime(now.year, now.month + 1, 1)

        rows = await self.repo.get_student_monthly_submissions(actor["userId"], start, end)
        if not rows:
            await message.answer("Bu oy uchun topshirilgan test natijalari topilmadi.", reply_markup=student_menu_keyboard())
            return

        month_text = f"{now.month:02d}.{now.year}"
        lines = []
        for idx, row in enumerate(rows, start=1):
            lines.append(
                f"{idx}) {format_date(row['createdAt'])}\n"
                f"{row['book_title']} | {row['lessonNumber']}-dars | {row['score']}/{row['totalQuestions']}"
            )

        await message.answer(f"📊 Joriy oy natijalari ({month_text})\n\n" + "\n\n".join(lines), reply_markup=student_menu_keyboard())

    async def _show_student_payment_info(self, message: Message, actor: dict) -> None:
        debt = await self._student_debt_summary(actor["student"]["id"])

        lines = []
        for idx, row in enumerate(debt["topRows"], start=1):
            lines.append(
                f"{idx}) {row['month']} | {row['groupCode']}\n"
                f"Talab: {format_money(row['net'])} | To'langan: {format_money(row['paid'])} | Qarz: {format_money(row['debt'])}"
            )

        text = (
            "💳 To'lov holati\n\n"
            f"Jami qarzdorlik: {format_money(debt['totalDebt'])} so'm\n"
            + (f"Shundan kechikkan davrlar uchun: {format_money(debt['totalExtra'])} so'm\n" if debt["totalExtra"] > 0 else "")
            + "\nTo'lov qilish uchun administrator: @ceo97\n\n"
            + ("Yaqin yozuvlar:\n" + "\n\n".join(lines) if lines else "To'lov yozuvlari topilmadi.")
        )

        await message.answer(text, reply_markup=student_menu_keyboard())

    async def _show_parent_debt(self, message: Message, actor: dict) -> None:
        debt = await self._student_debt_summary(actor["student"]["id"])
        if debt["totalDebt"] > 0:
            text = f"💸 Farzandingiz uchun qarzdorlik mavjud: {format_money(debt['totalDebt'])} so'm\nBatafsil uchun administrator: @ceo97"
        else:
            text = "✅ Hozircha qarzdorlik mavjud emas."
        await message.answer(text, reply_markup=parent_menu_keyboard())

    async def _show_parent_results(self, message: Message, actor: dict) -> None:
        student = actor["student"]
        tests = []
        if student.get("userId"):
            tests = await self.repo.get_parent_recent_submissions(student["userId"])

        journals = await self.repo.get_student_journal_rows(student["id"])

        if tests:
            test_text = "\n\n".join(
                f"{idx}) {format_date(row['createdAt'])}\n"
                f"{row['book_title']} | {row['lessonNumber']}-dars | {row['score']}/{row['totalQuestions']}"
                for idx, row in enumerate(tests, start=1)
            )
        else:
            test_text = "Test natijalari topilmadi."

        if journals:
            items = []
            for idx, row in enumerate(journals, start=1):
                lesson = "-"
                if row.get("lessonNumber") is not None and row.get("book_title"):
                    lesson = f"{row['book_title']} | {row['lessonNumber']}-dars"
                items.append(
                    f"{idx}) {format_date_only(row['journalDate'])} | {row['group_code']}\n"
                    f"{format_attendance(row['attendance'])}\n"
                    f"Dars: {lesson}\n"
                    f"Nazariy: {row.get('theoryScore') if row.get('theoryScore') is not None else '-'}% | "
                    f"Amaliy: {row.get('practicalScore') if row.get('practicalScore') is not None else '-'}%"
                )
            journal_text = "\n\n".join(items)
        else:
            journal_text = "Davomat/baholash natijalari topilmadi."

        await message.answer(f"📘 Oxirgi 10 ta test natija\n\n{test_text}", reply_markup=parent_menu_keyboard())
        await message.answer(f"🧾 Oxirgi 10 ta davomat va baholash\n\n{journal_text}", reply_markup=parent_menu_keyboard())

    async def _create_appeal_from_student(self, message: Message, actor: dict, text: str) -> bool:
        trimmed = text.strip()
        if len(trimmed) < 5:
            await message.answer("E'tiroz matni juda qisqa. Iltimos, batafsil yozing.", reply_markup=student_menu_keyboard())
            return False

        await self.repo.create_appeal(
            student_id=actor["student"]["id"],
            sender_type="STUDENT",
            sender_telegram_user_id=message.from_user.id,
            sender_phone=actor["student"]["phone"],
            text=trimmed,
        )
        await message.answer(
            "E'tirozingiz qabul qilindi ✅\nLoyiha rahbari Husniddin Ergashev ko'rib chiqadi.",
            reply_markup=student_menu_keyboard(),
        )
        return True

    async def _create_appeal_from_parent(self, message: Message, actor: dict, text: str) -> bool:
        trimmed = text.strip()
        if len(trimmed) < 5:
            await message.answer("Xabar juda qisqa. Iltimos, batafsil yozing.", reply_markup=parent_menu_keyboard())
            return False

        await self.repo.create_appeal(
            student_id=actor["student"]["id"],
            sender_type="PARENT",
            sender_telegram_user_id=message.from_user.id,
            sender_phone=actor["student"].get("parentPhone"),
            text=trimmed,
        )
        await message.answer(
            "E'tirozingiz qabul qilindi ✅\nLoyiha rahbari Husniddin Ergashev ko'rib chiqadi.",
            reply_markup=parent_menu_keyboard(),
        )
        return True

    async def _process_student_submission(self, message: Message, actor: dict, session: SessionState, text: str) -> bool:
        now = datetime.utcnow()
        if not session.active_window_id or not session.active_test_id:
            return False

        active_window = await self.repo.get_active_window_for_submit(
            window_id=session.active_window_id,
            student_user_id=actor["userId"],
            test_id=session.active_test_id,
            now=now,
        )

        if not active_window:
            self._clear_session(session)
            await message.answer("Sizda aktiv test yo'q.", reply_markup=student_menu_keyboard())
            return True

        test = active_window["test"]

        try:
            parsed = parse_answer_text(text, int(test["totalQuestions"]))
        except ParseError:
            await message.answer(
                f"Format xato. Namuna: 1A2B3C...{test['totalQuestions']}B",
                reply_markup=student_menu_keyboard(),
            )
            return True

        missing_numbers = [idx + 1 for idx, value in enumerate(parsed["byQuestion"]) if not value]
        if not self.settings.allow_partial_submissions and missing_numbers:
            preview = ", ".join(str(n) for n in missing_numbers[:20])
            suffix = " ..." if len(missing_numbers) > 20 else ""
            await message.answer(
                f"Javob to'liq emas. {test['totalQuestions']} ta savolning barchasini kiriting. Yetishmayotgan: {preview}{suffix}",
                reply_markup=student_menu_keyboard(),
            )
            return True

        key_raw = test["answerKey"]
        key = key_raw if isinstance(key_raw, list) else json.loads(key_raw)

        score = 0
        details = []
        for idx in range(int(test["totalQuestions"])):
            given = parsed["byQuestion"][idx] or None
            correct = key[idx] if idx < len(key) else ""
            is_correct = given == correct
            if is_correct:
                score += 1
            details.append(
                {
                    "questionNumber": idx + 1,
                    "givenAnswer": given,
                    "correctAnswer": correct,
                    "isCorrect": is_correct,
                }
            )

        submitted_at = datetime.utcnow()
        locked = await self.repo.lock_window_for_submission(
            window_id=active_window["id"],
            student_user_id=actor["userId"],
            test_id=test["id"],
            submitted_at=submitted_at,
        )
        if not locked:
            self._clear_session(session)
            await message.answer("Sizda aktiv test yo'q.", reply_markup=student_menu_keyboard())
            return True

        await self.repo.create_submission_with_details(
            student_user_id=actor["userId"],
            test_id=test["id"],
            raw_answer_text=text,
            parsed_answers=parsed["byQuestion"],
            score=score,
            details=details,
        )

        if message.chat:
            for msg_id in session.sent_test_message_ids:
                try:
                    await message.bot.delete_message(chat_id=message.chat.id, message_id=msg_id)
                except Exception:
                    pass

        self._clear_session(session)
        await message.answer("Qabul qilindi ✅", reply_markup=student_menu_keyboard())
        return True

    async def handle_text(self, message: Message) -> None:
        if not message.from_user or not message.text:
            return

        text = message.text.strip()
        session = self._get_session(message.from_user.id)
        actor = await self.repo.resolve_actor_by_telegram_user_id(message.from_user.id)

        if not actor:
            self._reset_to_phone(session)
            await message.answer(
                "Telefon raqamni qo'lda yozmang. Pastdagi tugma orqali yuboring.",
                reply_markup=phone_keyboard(),
            )
            return

        if session.awaiting_phone:
            session.awaiting_phone = False

        if actor["type"] == "STUDENT" and session.awaiting_appeal and text not in STUDENT_BUTTONS:
            saved = await self._create_appeal_from_student(message, actor, text)
            if saved:
                session.awaiting_appeal = False
            return

        if actor["type"] == "STUDENT":
            if text == STUDENT_BTN_APPEAL:
                session.awaiting_appeal = True
                await message.answer(
                    "E'tirozingizni yozishingiz mumkin. Bu xabar to'g'ridan-to'g'ri loyiha rahbari Husniddin Ergashevga yuboriladi.",
                    reply_markup=student_menu_keyboard(),
                )
                return

            if text == STUDENT_BTN_RESULTS:
                session.awaiting_appeal = False
                await self._show_student_monthly_results(message, actor)
                return

            if text == STUDENT_BTN_PAY:
                session.awaiting_appeal = False
                await self._show_student_payment_info(message, actor)
                return

            if text == STUDENT_BTN_TEST:
                session.awaiting_appeal = False
                active_window = await self.repo.get_active_window(actor["userId"])
                if not active_window:
                    await message.answer("Hozircha aktiv test yo'q.", reply_markup=student_menu_keyboard())
                    return

                session.active_test_id = active_window["testId"]
                session.active_window_id = active_window["id"]
                session.sent_test_message_ids = []

                if active_window.get("openedAt"):
                    await message.answer(
                        f"Sizga test allaqachon yuborilgan.\nJavoblarni shu botga yuboring. Namuna: 1A2B3C...{active_window['test']['totalQuestions']}B",
                        reply_markup=student_menu_keyboard(),
                        protect_content=True,
                    )
                    return

                keyboard = InlineKeyboardMarkup(
                    inline_keyboard=[[
                        InlineKeyboardButton(text="📝 Testni ochish", callback_data=f"open_test:{active_window['testId']}")
                    ]]
                )
                await message.answer(
                    f"Sizga ochiq test: {active_window['test']['lesson']['book']['title']} | {active_window['test']['lesson']['lessonNumber']}-dars",
                    reply_markup=keyboard,
                    protect_content=True,
                )
                return

            if session.active_test_id:
                handled = await self._process_student_submission(message, actor, session, text)
                if handled:
                    return

            await message.answer("Kerakli tugmani tanlang.", reply_markup=student_menu_keyboard())
            return

        # Parent flow
        if session.awaiting_appeal and text not in PARENT_BUTTONS:
            saved = await self._create_appeal_from_parent(message, actor, text)
            if saved:
                session.awaiting_appeal = False
            return

        if text == PARENT_BTN_RESULTS:
            session.awaiting_appeal = False
            await self._show_parent_results(message, actor)
            return

        if text == PARENT_BTN_DEBT:
            session.awaiting_appeal = False
            await self._show_parent_debt(message, actor)
            return

        if text == PARENT_BTN_APPEAL:
            session.awaiting_appeal = True
            await message.answer(
                "E'tirozingizni yozishingiz mumkin. Bu xabar to'g'ridan-to'g'ri loyiha rahbari Husniddin Ergashevga yuboriladi.",
                reply_markup=parent_menu_keyboard(),
            )
            return

        if text not in PARENT_BUTTONS:
            await self._create_appeal_from_parent(message, actor, text)
            return

        await message.answer("Kerakli tugmani tanlang.", reply_markup=parent_menu_keyboard())

    async def handle_open_test(self, callback: CallbackQuery) -> None:
        if not callback.from_user:
            await callback.answer("Xatolik: foydalanuvchi aniqlanmadi", show_alert=True)
            return

        actor = await self.repo.resolve_actor_by_telegram_user_id(callback.from_user.id)
        if not actor or actor["type"] != "STUDENT":
            await callback.answer("Avval /start qiling", show_alert=True)
            return

        data = callback.data or ""
        test_id = data.split(":", 1)[1] if ":" in data else ""

        active_window = await self.repo.get_active_window(actor["userId"])
        if not active_window or active_window["testId"] != test_id:
            await callback.answer("Bu test hozir yopiq", show_alert=True)
            return

        session = self._get_session(callback.from_user.id)

        if active_window.get("openedAt"):
            session.active_test_id = test_id
            session.active_window_id = active_window["id"]
            await callback.answer("Test allaqachon ochilgan. Javoblarni yuboring.", show_alert=True)
            return

        opened_at = datetime.utcnow()
        marked = await self.repo.mark_window_opened_once(active_window["id"], opened_at)
        if not marked:
            await callback.answer("Bu tugma allaqachon ishlatilgan.", show_alert=True)
            return

        session.active_test_id = test_id
        session.active_window_id = active_window["id"]
        session.sent_test_message_ids = []

        msg = callback.message
        if not msg:
            await callback.answer("Xatolik: xabar topilmadi", show_alert=True)
            return

        try:
            images = active_window["test"].get("images", [])
            if not images:
                raise RuntimeError("TEST_CONTENT_NOT_SET")

            for image in images:
                sent_id = await self._send_test_image(msg, image["imageUrl"])
                if sent_id:
                    session.sent_test_message_ids.append(sent_id)

            instruction = await msg.answer(
                f"Javoblarni bitta qatorda yuboring. Masalan: 1A2B3C...{active_window['test']['totalQuestions']}B",
                reply_markup=student_menu_keyboard(),
                protect_content=True,
            )
            if instruction:
                session.sent_test_message_ids.append(instruction.message_id)

        except Exception as error:
            print("OPEN_TEST_SEND_ERROR", error)
            await self.repo.reset_window_opened(active_window["id"])
            text = (
                "Bu testga rasm biriktirilmagan. Admin 2 ta rasm URL ni to'ldirishi kerak."
                if str(error) == "TEST_CONTENT_NOT_SET"
                else "Testni ochishda xatolik bo'ldi, qayta urinib ko'ring."
            )
            await callback.answer(text, show_alert=True)
            return

        await callback.answer()

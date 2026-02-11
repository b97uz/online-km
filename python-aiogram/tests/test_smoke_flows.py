from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from config import Settings
from routers.callbacks import router as callbacks_router
from routers.commands import router as commands_router
from routers.contacts import router as contacts_router
from routers.messages import router as messages_router
from services.bot_logic import BotLogic
from services.session_store import SessionStore
from services.types import SessionState


def test_router_mapping_smoke() -> None:
    assert len(commands_router.message.handlers) >= 2
    assert len(contacts_router.message.handlers) >= 1
    assert len(callbacks_router.callback_query.handlers) >= 1
    assert len(messages_router.message.handlers) >= 1


@dataclass
class DummyChat:
    id: int


class DummyBot:
    def __init__(self) -> None:
        self.deleted: list[int] = []

    async def delete_message(self, chat_id: int, message_id: int) -> None:
        assert chat_id == 9001
        self.deleted.append(message_id)


class DummyMessage:
    def __init__(self) -> None:
        self.chat = DummyChat(id=9001)
        self.bot = DummyBot()
        self.answers: list[str] = []

    async def answer(self, text: str, **_: Any) -> Any:
        self.answers.append(text)
        return type("Reply", (), {"message_id": 123})()


class FakeRepo:
    def __init__(self) -> None:
        self.lock_calls = 0
        self.created: list[dict[str, Any]] = []

    async def get_active_window_for_submit(
        self,
        window_id: str,
        student_user_id: str,
        test_id: str,
        now: Any,
    ) -> dict[str, Any] | None:
        assert window_id == "w1"
        assert student_user_id == "u1"
        assert test_id == "t1"
        assert now is not None
        return {
            "id": "w1",
            "test": {
                "id": "t1",
                "totalQuestions": 3,
                "answerKey": ["A", "B", "C"],
            },
        }

    async def lock_window_for_submission(
        self,
        window_id: str,
        student_user_id: str,
        test_id: str,
        submitted_at: Any,
    ) -> bool:
        assert window_id == "w1"
        assert student_user_id == "u1"
        assert test_id == "t1"
        assert submitted_at is not None
        self.lock_calls += 1
        return True

    async def create_submission_with_details(
        self,
        student_user_id: str,
        test_id: str,
        raw_answer_text: str,
        parsed_answers: list[str],
        score: int,
        details: list[dict[str, Any]],
    ) -> str:
        self.created.append(
            {
                "student_user_id": student_user_id,
                "test_id": test_id,
                "raw_answer_text": raw_answer_text,
                "parsed_answers": parsed_answers,
                "score": score,
                "details_count": len(details),
            }
        )
        return "sub-1"


@pytest.mark.asyncio
async def test_submission_db_write_smoke() -> None:
    repo = FakeRepo()
    logic = BotLogic(
        repo=repo,  # type: ignore[arg-type]
        settings=Settings(
            bot_token="x",
            web_base_url="http://localhost:3000",
            database_url="postgres://x",
            webhook_url=None,
            webhook_path=None,
            bot_port=4000,
            node_env="development",
            allow_partial_submissions=False,
            debug_updates=False,
        ),
        sessions=SessionStore(),
    )

    session = SessionState(
        awaiting_phone=False,
        awaiting_appeal=False,
        active_test_id="t1",
        active_window_id="w1",
        sent_test_message_ids=[11, 22],
    )
    actor = {"userId": "u1", "student": {"id": "s1"}}
    message = DummyMessage()

    handled = await logic._process_student_submission(message, actor, session, "1A2B3C")

    assert handled is True
    assert repo.lock_calls == 1
    assert len(repo.created) == 1
    assert repo.created[0]["score"] == 3
    assert repo.created[0]["details_count"] == 3
    assert session.active_test_id is None
    assert session.active_window_id is None
    assert message.bot.deleted == [11, 22]
    assert message.answers[-1] == "Qabul qilindi ✅"

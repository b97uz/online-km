from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


ActorType = Literal["STUDENT", "PARENT"]


@dataclass
class SessionState:
    awaiting_phone: bool = True
    awaiting_appeal: bool = False
    active_test_id: str | None = None
    active_window_id: str | None = None
    sent_test_message_ids: list[int] = field(default_factory=list)


@dataclass
class StudentActor:
    type: Literal["STUDENT"]
    user_id: str
    student: dict


@dataclass
class ParentActor:
    type: Literal["PARENT"]
    student: dict

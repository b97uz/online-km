from __future__ import annotations

from typing import Dict

from .types import SessionState


class SessionStore:
    def __init__(self) -> None:
        self._items: Dict[int, SessionState] = {}

    def get(self, user_id: int) -> SessionState:
        existing = self._items.get(user_id)
        if existing is not None:
            return existing
        state = SessionState()
        self._items[user_id] = state
        return state

    def set(self, user_id: int, state: SessionState) -> None:
        self._items[user_id] = state

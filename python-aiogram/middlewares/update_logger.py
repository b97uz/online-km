from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict

from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Update


class UpdateLoggerMiddleware(BaseMiddleware):
    async def __call__(
        self,
        handler: Callable[[TelegramObject, Dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: Dict[str, Any],
    ) -> Any:
        if isinstance(event, Update) and event.message and event.message.from_user:
            print(
                "UPDATE",
                {
                    "updateId": event.update_id,
                    "fromId": event.message.from_user.id,
                    "text": event.message.text,
                },
            )
        return await handler(event, data)

from __future__ import annotations

from aiogram import F, Router
from aiogram.types import Message

from services.bot_logic import BotLogic

router = Router(name="messages")


@router.message(F.text)
async def text_handler(message: Message, logic: BotLogic) -> None:
    await logic.handle_text(message)

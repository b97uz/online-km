from __future__ import annotations

from aiogram import F, Router
from aiogram.types import Message

from services.bot_logic import BotLogic

router = Router(name="contacts")


@router.message(F.contact)
async def contact_handler(message: Message, logic: BotLogic) -> None:
    await logic.handle_contact(message)

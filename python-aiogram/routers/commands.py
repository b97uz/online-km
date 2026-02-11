from __future__ import annotations

from aiogram import Router
from aiogram.filters import Command
from aiogram.types import Message

from services.bot_logic import BotLogic

router = Router(name="commands")


@router.message(Command("start"))
async def start_handler(message: Message, logic: BotLogic) -> None:
    await logic.handle_start(message)


@router.message(Command("ping"))
async def ping_handler(message: Message, logic: BotLogic) -> None:
    await logic.handle_ping(message)

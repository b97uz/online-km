from __future__ import annotations

from aiogram import Dispatcher

from .callbacks import router as callbacks_router
from .commands import router as commands_router
from .contacts import router as contacts_router
from .messages import router as messages_router

ALL_ROUTERS = [commands_router, contacts_router, callbacks_router, messages_router]


def register_routers(dp: Dispatcher) -> None:
    dp.include_router(commands_router)
    dp.include_router(contacts_router)
    dp.include_router(callbacks_router)
    dp.include_router(messages_router)

from __future__ import annotations

import asyncio

from aiohttp import web
from aiogram import Bot, Dispatcher
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application

from config import load_settings
from db.pool import create_pool
from db.repository import BotRepository
from middlewares.update_logger import UpdateLoggerMiddleware
from routers import register_routers
from services.bot_logic import BotLogic
from services.session_store import SessionStore


async def run_polling(bot: Bot, dp: Dispatcher) -> None:
    print("Mode: long-polling")
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


async def run_webhook(bot: Bot, dp: Dispatcher, port: int, webhook_path: str, webhook_url: str) -> None:
    print("Mode: webhook")
    await bot.set_webhook(f"{webhook_url}{webhook_path}")

    app = web.Application()
    handler = SimpleRequestHandler(dispatcher=dp, bot=bot)
    handler.register(app, path=webhook_path)
    setup_application(app, dp, bot=bot)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=port)
    await site.start()

    print(f"Bot webhook rejimida ishga tushdi: {port}")
    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        await runner.cleanup()


async def main() -> None:
    settings = load_settings()
    pool = await create_pool(settings.database_url)
    repo = BotRepository(pool=pool)
    sessions = SessionStore()

    bot = Bot(token=settings.bot_token)
    dp = Dispatcher()

    if settings.debug_updates:
        dp.update.outer_middleware(UpdateLoggerMiddleware())

    logic = BotLogic(repo=repo, settings=settings, sessions=sessions)

    dp["logic"] = logic
    dp["repo"] = repo
    dp["settings"] = settings
    dp["sessions"] = sessions

    register_routers(dp)

    me = await bot.get_me()
    print(f"Bot: @{me.username or me.first_name} | NODE_ENV={settings.node_env}")

    use_webhook = settings.is_production and bool(settings.webhook_path) and bool(settings.webhook_url)

    try:
        if use_webhook:
            await run_webhook(bot, dp, settings.bot_port, settings.webhook_path or "", settings.webhook_url or "")
        else:
            await run_polling(bot, dp)
    finally:
        await repo.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())

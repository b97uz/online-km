from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    bot_token: str
    web_base_url: str
    database_url: str
    webhook_url: str | None
    webhook_path: str | None
    bot_port: int
    node_env: str
    allow_partial_submissions: bool
    debug_updates: bool

    @property
    def is_production(self) -> bool:
        return self.node_env == "production"



def load_settings() -> Settings:
    # Prioritize local .env files but keep names exactly the same as existing project.
    root_env = Path(__file__).resolve().parents[1] / ".env"
    local_env = Path(__file__).resolve().parent / ".env"

    if root_env.exists():
        load_dotenv(root_env)
    if local_env.exists():
        load_dotenv(local_env, override=False)

    bot_token = os.getenv("BOT_TOKEN", "").strip()
    web_base_url = os.getenv("WEB_BASE_URL", "").strip()
    database_url = os.getenv("DATABASE_URL", "").strip()

    if not bot_token:
        raise RuntimeError("BOT_TOKEN .env da bo'lishi shart")
    if not web_base_url:
        raise RuntimeError("WEB_BASE_URL .env da bo'lishi shart")
    if not database_url:
        raise RuntimeError("DATABASE_URL .env da bo'lishi shart")

    webhook_url = os.getenv("BOT_WEBHOOK_URL")
    webhook_path = os.getenv("BOT_WEBHOOK_PATH")

    return Settings(
        bot_token=bot_token,
        web_base_url=web_base_url,
        database_url=database_url,
        webhook_url=webhook_url.strip() if webhook_url else None,
        webhook_path=webhook_path.strip() if webhook_path else None,
        bot_port=int(os.getenv("BOT_PORT", "4000")),
        node_env=os.getenv("NODE_ENV", "development"),
        allow_partial_submissions=os.getenv("ALLOW_PARTIAL_SUBMISSIONS", "false").lower() == "true",
        debug_updates=os.getenv("NODE_ENV", "development") != "production",
    )

"""Impostazioni dell'applicazione lette dalle variabili d'ambiente."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "si", "on"}


class Settings:
    def __init__(self) -> None:
        self.connectors = [
            c.strip().lower()
            for c in os.getenv("CONNECTORS", "zucchetti,demo").split(",")
            if c.strip()
        ]
        self.data_dir = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
        self.zucchetti_config = Path(
            os.getenv("ZUCCHETTI_CONFIG", str(BASE_DIR / "config" / "zucchetti.json"))
        )
        self.cookie_secure = _bool("COOKIE_SECURE", False)
        self.cookie_name = os.getenv("COOKIE_NAME", "rtkt_sid")
        self.session_idle_minutes = int(os.getenv("SESSION_IDLE_MINUTES", "480"))
        self.max_sessions = int(os.getenv("MAX_SESSIONS", "500"))
        self.diagnostics = _bool("APP_DIAGNOSTICS", False)
        self.allowed_users = {
            u.strip().lower()
            for u in os.getenv("ALLOWED_USERS", "").split(",")
            if u.strip()
        }
        self.demo_size = int(os.getenv("DEMO_SIZE", "40000"))
        self.demo_latency_ms = int(os.getenv("DEMO_LATENCY_MS", "250"))
        self.login_attempts_per_10min = int(os.getenv("LOGIN_ATTEMPTS_PER_10MIN", "10"))
        self.cache_ttl_seconds = int(os.getenv("CACHE_TTL_SECONDS", "600"))

    def load_zucchetti_config(self) -> dict:
        with open(self.zucchetti_config, encoding="utf-8") as fh:
            return json.load(fh)


@lru_cache
def get_settings() -> Settings:
    return Settings()

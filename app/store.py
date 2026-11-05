"""Archivio locale (SQLite): ricerche salvate, cronologia, preferiti con note e tag.

Non contiene ticket scaricati in massa: solo ciò che l'utente salva esplicitamente.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

HISTORY_LIMIT = 300


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS saved_searches(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, name TEXT NOT NULL,
                    spec TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS ix_saved_user ON saved_searches(user);
                CREATE TABLE IF NOT EXISTS history(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, spec TEXT NOT NULL,
                    summary TEXT NOT NULL, results INTEGER NOT NULL, created TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS ix_history_user ON history(user, id);
                CREATE TABLE IF NOT EXISTS favorites(
                    user TEXT NOT NULL, key TEXT NOT NULL, ticket TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
                    created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(user, key));
                """
            )

    def _exec(self, sql: str, params: tuple = ()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _all(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    # --- ricerche salvate ---------------------------------------------------
    def list_saved(self, user: str) -> list[dict]:
        rows = self._all("SELECT * FROM saved_searches WHERE user=? ORDER BY name COLLATE NOCASE", (user,))
        for r in rows:
            r["spec"] = json.loads(r["spec"])
            r.pop("user", None)
        return rows

    def save_search(self, user: str, name: str, spec: dict, search_id: int | None = None) -> int:
        now = _now()
        if search_id:
            cur = self._exec(
                "UPDATE saved_searches SET name=?, spec=?, updated=? WHERE id=? AND user=?",
                (name, json.dumps(spec), now, search_id, user),
            )
            if cur.rowcount:
                return search_id
        cur = self._exec(
            "INSERT INTO saved_searches(user,name,spec,created,updated) VALUES(?,?,?,?,?)",
            (user, name, json.dumps(spec), now, now),
        )
        return int(cur.lastrowid)

    def delete_saved(self, user: str, search_id: int) -> bool:
        return self._exec("DELETE FROM saved_searches WHERE id=? AND user=?", (search_id, user)).rowcount > 0

    # --- cronologia ------------------------------------------------------------
    def add_history(self, user: str, spec: dict, summary: str, results: int) -> None:
        self._exec(
            "INSERT INTO history(user,spec,summary,results,created) VALUES(?,?,?,?,?)",
            (user, json.dumps(spec), summary[:300], results, _now()),
        )
        self._exec(
            "DELETE FROM history WHERE user=? AND id NOT IN "
            "(SELECT id FROM history WHERE user=? ORDER BY id DESC LIMIT ?)",
            (user, user, HISTORY_LIMIT),
        )

    def list_history(self, user: str, limit: int = 100) -> list[dict]:
        rows = self._all("SELECT * FROM history WHERE user=? ORDER BY id DESC LIMIT ?", (user, limit))
        for r in rows:
            r["spec"] = json.loads(r["spec"])
            r.pop("user", None)
        return rows

    def clear_history(self, user: str) -> None:
        self._exec("DELETE FROM history WHERE user=?", (user,))

    def history_terms(self, user: str, prefix: str, limit: int = 6) -> list[str]:
        out: list[str] = []
        for r in self._all("SELECT summary FROM history WHERE user=? ORDER BY id DESC LIMIT 200", (user,)):
            s = r["summary"]
            if s.lower().startswith(prefix.lower()) and s not in out:
                out.append(s)
            if len(out) >= limit:
                break
        return out

    # --- preferiti -------------------------------------------------------------
    def list_favorites(self, user: str) -> list[dict]:
        rows = self._all("SELECT * FROM favorites WHERE user=? ORDER BY updated DESC", (user,))
        for r in rows:
            r["ticket"] = json.loads(r["ticket"])
            r["tags"] = json.loads(r["tags"])
            r.pop("user", None)
        return rows

    def upsert_favorite(self, user: str, key: str, ticket: dict, note: str, tags: list[str]) -> None:
        now = _now()
        self._exec(
            "INSERT INTO favorites(user,key,ticket,note,tags,created,updated) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(user,key) DO UPDATE SET ticket=excluded.ticket, note=excluded.note, "
            "tags=excluded.tags, updated=excluded.updated",
            (user, key, json.dumps(ticket), note, json.dumps(tags), now, now),
        )

    def delete_favorite(self, user: str, key: str) -> bool:
        return self._exec("DELETE FROM favorites WHERE user=? AND key=?", (user, key)).rowcount > 0

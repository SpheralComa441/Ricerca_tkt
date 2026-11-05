import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

H = {"x-rtkt": "1"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CONNECTORS", "demo")
    monkeypatch.setenv("DEMO_SIZE", "12000")
    monkeypatch.setenv("DEMO_LATENCY_MS", "0")
    monkeypatch.setenv("APP_DIAGNOSTICS", "1")
    with TestClient(create_app(Settings())) as c:
        yield c


def login(c):
    r = c.post("/api/login", json={"connector": "demo", "username": "Mario", "password": "demo"}, headers=H)
    assert r.status_code == 200, r.text


def events(r):
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def test_requires_login_and_csrf(client):
    assert client.get("/api/me").json() == {"authenticated": False}
    assert client.post("/api/search", json={"text": "x"}, headers=H).status_code == 401
    r = client.post("/api/login", json={"connector": "demo", "username": "a", "password": "demo"})
    assert r.status_code == 403  # manca l'intestazione anti-CSRF
    r = client.post("/api/login", json={"connector": "demo", "username": "a", "password": "x"}, headers=H)
    assert r.status_code == 401


def test_security_headers(client):
    r = client.get("/")
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"


def test_search_stream_and_history(client):
    login(client)
    r = client.post("/api/search", json={"text": "detassazione", "extended": {"enabled": True}}, headers=H)
    evs = events(r)
    assert evs[0]["type"] == "start" and evs[-1]["type"] == "done"
    found = sum(len(e["tickets"]) for e in evs if e["type"] == "batch")
    assert found == evs[-1]["stats"]["found"] > 210
    hist = client.get("/api/history").json()["items"]
    assert hist[0]["summary"] == "detassazione" and hist[0]["results"] == found


def test_bad_query(client):
    login(client)
    assert client.post("/api/search", json={}, headers=H).status_code == 400
    r = client.post("/api/search", json={"text": "(a OR", "mode": "solr"}, headers=H)
    assert any(e["type"] == "warning" for e in events(r))


def test_saved_and_favorites(client):
    login(client)
    r = client.post("/api/saved", json={"name": "Prova", "spec": {"text": "tfr"}}, headers=H)
    sid = r.json()["id"]
    assert client.get("/api/saved").json()["items"][0]["name"] == "Prova"
    assert client.delete(f"/api/saved/{sid}", headers=H).json()["ok"]

    fav = {"key": "n1", "ticket": {"key": "n1", "number": 1}, "note": "nota", "tags": ["a", " b "]}
    assert client.post("/api/favorites", json=fav, headers=H).json()["ok"]
    items = client.get("/api/favorites").json()["items"]
    assert items[0]["tags"] == ["a", "b"] and items[0]["note"] == "nota"
    assert client.delete("/api/favorites/n1", headers=H).json()["ok"]


def test_preview_and_suggest(client):
    login(client)
    r = client.post("/api/query-preview", json={"text": "a b", "mode": "any"}, headers=H).json()
    assert r["query"] == "a OR b"
    s = client.get("/api/suggest", params={"q": "busta detass"}).json()["suggestions"]
    assert "busta detassazione" in s


def test_demo_ticket_page_and_diag(client):
    login(client)
    r = client.post("/api/search", json={"text": "tfr"}, headers=H)
    t = next(e for e in events(r) if e["type"] == "batch")["tickets"][0]
    assert t["url"].startswith("/demo/ticket/")
    page = client.get(t["url"])
    assert page.status_code == 200 and "Ticket #" in page.text
    raw = client.post("/api/diag/raw", json={"query": "tfr"}, headers=H).json()
    assert raw["parsed"]["count"] > 0

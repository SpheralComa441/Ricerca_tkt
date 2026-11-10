import json
from pathlib import Path

import pytest

from app.query import Profile

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def zcfg() -> dict:
    return json.loads((ROOT / "config" / "zucchetti.json").read_text(encoding="utf-8"))


@pytest.fixture
def zprofile(zcfg) -> Profile:
    return Profile(zcfg)


@pytest.fixture
def sample_response() -> str:
    return (FIXTURES / "zucchetti_response.json").read_text(encoding="utf-8")

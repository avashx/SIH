import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import registry  # noqa: E402


def _built() -> bool:
    return (ROOT / "data" / "processed" / "stats.json").exists()


needs_data = pytest.mark.skipif(not _built(), reason="run `make data` first")


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from backend.app import app
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def meta(client):
    return client.get("/api/meta").json()


@pytest.fixture(scope="session")
def stats():
    return registry.stats()

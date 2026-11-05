import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Tests never reach a paid or remote model: backend/.env may point Pip at OpenRouter for trying models.
os.environ["OPENROUTER_API_KEY"] = ""
os.environ["AGENT_MODEL"] = "claude-haiku-5-5"
os.environ["ADMIN_AI_MODEL"] = ""

from app.main import app


@pytest.fixture(scope="session")
def client():
    # Uses the real local Postgres/Redis from backend/.env; lifespan loads the catalog and index.
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def brain(client):
    from app.brain import RuleBrain
    from app.catalog import catalog

    return RuleBrain(catalog)


@pytest.fixture
def ai_tryon():
    """AI try-on switched on: clothes and shoes can be tried on too (without it, only accessories)."""
    from .fakes import Settings

    s = Settings()
    s(fashn_api_key="test")
    yield
    s.restore()


@pytest.fixture(scope="session")
def demo_user_id():
    import psycopg

    from app.config import settings

    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute("""select id from "User" where email='demo@cartly.dev'""").fetchone()
    return row[0] if row else None


@pytest.fixture(scope="session")
def demo_latest_order(demo_user_id):
    """The demo shopper's newest order, whatever the local database holds (seeds and test runs change it)."""
    import psycopg

    from app.config import settings

    if not demo_user_id:
        return None
    with psycopg.connect(settings.database_url) as conn:
        row = conn.execute(
            """select id, status from "Order" where "userId" = %s order by "createdAt" desc limit 1""", (demo_user_id,)
        ).fetchone()
    return {"id": row[0], "status": row[1]} if row else None

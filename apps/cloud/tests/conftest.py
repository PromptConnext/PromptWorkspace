import os

# Tests must be hermetic and never depend on a developer's local .env.local
# (e.g. one pointing DATA_BACKEND/AUTH_MODE at a local Supabase instance).
# Real process environment variables take precedence over env_file values in
# pydantic-settings, so setting these here — before app.config is imported —
# forces the memory backend + stub auth CLAUDE.md documents as the test
# default, regardless of what's in the developer's .env.local.
os.environ["DATA_BACKEND"] = "memory"
os.environ["AUTH_MODE"] = "stub"
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)
os.environ.pop("SUPABASE_JWT_SECRET", None)

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    # Fresh app (and fresh in-memory repository) per test.
    app = create_app()
    with TestClient(app) as c:
        yield c

import os

# Tests must be hermetic and never depend on a developer's local .env.local
# (e.g. one pointing DATA_BACKEND/AUTH_MODE at a local Supabase instance, or
# one with MANAGED_MODEL_ENABLED set). This flag makes app.config skip the
# .env.local/.env files entirely — set here, before app.config is imported, so
# every setting falls back to its declared default rather than only the few
# this file used to pin by name.
os.environ["PZ_DISABLE_ENV_FILE"] = "1"

# Belt and braces: real process environment variables take precedence over
# env_file values in pydantic-settings, so a developer exporting these in their
# shell (not just their .env.local) still lands on the memory backend + stub
# auth that CLAUDE.md documents as the test default.
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

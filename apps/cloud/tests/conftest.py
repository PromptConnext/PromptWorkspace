import os

# Tests must be hermetic and never depend on a developer's local .env.local
# (e.g. one pointing DATA_BACKEND/AUTH_MODE at a local Supabase instance, or
# one with MANAGED_MODEL_ENABLED set). This flag makes app.config skip the
# .env.local/.env files entirely — set here, before app.config is imported, so
# every setting falls back to its declared default rather than only the few
# this file used to pin by name.
os.environ["PROMPTWORKSPACE_DISABLE_ENV_FILE"] = "1"

# Belt and braces: real process environment variables take precedence over
# env_file values in pydantic-settings, so a developer exporting these in their
# shell (not just their .env.local) still lands on the memory backend + stub
# auth that CLAUDE.md documents as the test default.
os.environ["DATA_BACKEND"] = "memory"
os.environ["AUTH_MODE"] = "stub"
os.environ.pop("SUPABASE_URL", None)
os.environ.pop("SUPABASE_KEY", None)
os.environ.pop("SUPABASE_JWT_SECRET", None)

# Same reasoning for the managed tier: a developer who exported the Typhoon
# settings in their shell (or sourced .env.local into it) would otherwise give
# every app instance a managed connection, and tests that assert the
# no-model-configured failure path (400 model_connection_not_configured) would
# instead see a working managed fallback. Tests that need the managed tier set
# it up explicitly rather than inheriting it from the ambient environment.
os.environ.pop("MANAGED_MODEL_ENABLED", None)
os.environ.pop("MANAGED_MODEL_API_KEY", None)
os.environ.pop("MANAGED_MODEL_BASE_URL", None)
os.environ.pop("MANAGED_MODEL_NAME", None)
os.environ.pop("MANAGED_MODEL_MAX_TOKENS", None)
os.environ.pop("MANAGED_DAILY_TOKEN_BUDGET", None)
os.environ.pop("MANAGED_EMBED_BASE_URL", None)
os.environ.pop("MANAGED_EMBED_MODEL", None)
os.environ.pop("MANAGED_EMBED_DIM", None)
os.environ.pop("MANAGED_EMBED_API_KEY", None)

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    # Fresh app (and fresh in-memory repository) per test.
    app = create_app()
    with TestClient(app) as c:
        yield c

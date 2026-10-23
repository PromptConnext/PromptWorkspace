"""The repository contract's own fixtures — one `repo`, both adapters.

Plan 0020 (`docs/plans/0020-repository-contract-suite.md`) implements finding 22
of the 2026-09-06 cloud codebase review: every test in `apps/cloud/tests/`
exercises `InMemoryRepository`, so a green run establishes the behaviour of the
in-memory double and nothing about `SupabaseRepository`, the class that runs in
production. The cases under this package talk to a `Repository` through its
public interface only and never learn which implementation they hold, so the
same assertions run against both.

The root `tests/conftest.py` pins `DATA_BACKEND=memory`, pins `AUTH_MODE=stub`
and *deletes* `SUPABASE_URL`/`SUPABASE_KEY` before `app.config` is imported.
That pinning is deliberate and untouched here — it is what keeps `pytest -q`
offline, container-free and fast. This package does not go around it: neither
adapter is built through `create_app`, so `settings.data_backend`,
`_build_repository` and the FastAPI `client` fixture are all out of the picture.
The supabase parameter reads a *dedicated* pair of variables the root conftest
does not touch:

    PROMPTWORKSPACE_CONTRACT_SUPABASE_URL
    PROMPTWORKSPACE_CONTRACT_SUPABASE_KEY

Unset (the default, and the state of every ordinary `pytest` run) means the
supabase parameter is **skipped with a reason naming the variable that is
missing** — never silently dropped, because a suite that reports green while
having exercised nothing is the defect this plan exists to fix.

Standing the target up locally (plan 0020 M2), from the repository root:

    supabase start                                    # supabase/config.toml, db on :54322
    cd apps/cloud
    DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \\
      scripts/migrate.py apply --var embed_dim=1024   # 0023 refuses without the var
    # No hand grants: 0005_pw_service_role_grants.sql grants `service_role`
    # what the server reaches, exactly as on a new hosted project.
    export PROMPTWORKSPACE_CONTRACT_SUPABASE_URL=http://127.0.0.1:54321
    export PROMPTWORKSPACE_CONTRACT_SUPABASE_KEY=<SERVICE_ROLE_KEY from `supabase start`>
    pytest -q -m contract

Reset is `supabase db reset` (re-apply migrations afterwards), not a
hand-written `delete from` list that a new migration can silently outgrow. No
case here cleans up after itself and none needs to: every workspace, user,
project and entity id is a fresh uuid, so cases cannot see each other's rows
and a second run against a used database behaves like the first.
"""

from __future__ import annotations

import os

import pytest

from app.db.repository import InMemoryRepository, Repository

_URL_VAR = "PROMPTWORKSPACE_CONTRACT_SUPABASE_URL"
_KEY_VAR = "PROMPTWORKSPACE_CONTRACT_SUPABASE_KEY"
# Set by the job whose entire purpose is to reach the adapter (see
# .github/workflows/cloud-contract.yml). A nightly that skipped every supabase
# case must not read as green, so where the run is *supposed* to have a target,
# the absent variable is a failure rather than a skip.
_REQUIRE_VAR = "PROMPTWORKSPACE_CONTRACT_REQUIRE_SUPABASE"

BACKENDS = ("memory", "supabase")


def _required() -> bool:
    return os.environ.get(_REQUIRE_VAR, "").strip().lower() not in ("", "0", "false", "no")


@pytest.fixture(scope="session")
def _supabase_repository() -> Repository:
    """One client for the session; skipped, loudly, when unconfigured."""
    url = os.environ.get(_URL_VAR, "").strip()
    key = os.environ.get(_KEY_VAR, "").strip()
    missing = [name for name, value in ((_URL_VAR, url), (_KEY_VAR, key)) if not value]
    if missing:
        reason = (
            "supabase contract backend not configured: "
            + " and ".join(missing)
            + (" is" if len(missing) == 1 else " are")
            + " unset (see tests/contract/conftest.py for the local setup)"
        )
        if _required():
            pytest.fail(f"{reason}; {_REQUIRE_VAR} forbids skipping it", pytrace=False)
        pytest.skip(reason)
    try:
        from app.db.supabase_repository import SupabaseRepository
    except ImportError as exc:  # pragma: no cover - requirements.txt ships it
        if _required():
            pytest.fail(f"supabase contract backend unavailable: {exc}", pytrace=False)
        pytest.skip(f"supabase contract backend unavailable: {exc}")
    return SupabaseRepository(url, key)


@pytest.fixture(params=BACKENDS)
def repo(request: pytest.FixtureRequest) -> Repository:
    """The repository under contract. Parametrised over the adapters available
    in this environment; `repo.backend_name` is "memory" or "supabase"."""
    if request.param == "memory":
        return InMemoryRepository()
    return request.getfixturevalue("_supabase_repository")

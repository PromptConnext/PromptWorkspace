# ADR 0023 — Development Preview for Every Project Type: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the ADR 0021 preview to five delivery kinds, attribute every build to the tasks inside it, and present both to a business user who never sees a commit.

**Architecture:** A Deployment Template gains one discriminator (`delivery_kind`) that decides presentation, never dispatch on `stack`. Every delivery kind reuses the one per-repo webhook, the one `pz_deployments` row and one new nullable `assets` column — no new inbound channel, no per-template route or column. The cloud starts *reading* task refs off `push` deliveries to write attribution artifacts (never task status), freezes each terminal build's task set into `pz_deployment_tasks`, and renders it as "what's in this build".

**Tech Stack:** FastAPI + Pydantic v2 (`apps/cloud`, Python ≥3.10, pytest, ruff line-length 100) · Next.js 16 / React 19 / Tailwind / vitest (`apps/web`) · GitHub Actions template scaffolds committed verbatim into customer repositories.

**Spec:** `docs/decisions/0023-development-preview-for-every-project-type.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **No cloud-side build runner.** The project's own CI builds and deploys; the cloud observes. (ADR 0021 decision 3, re-asserted by ADR 0023 decision 8.)
- **No proxy or rehost of application traffic**, including a reverse proxy that exists only to strip a framing header. The browser calls the deployed app and the deployed API directly.
- **No new inbound channel.** Events arrive only on the existing per-repo webhook with the existing per-repo HMAC secret, and only these four types: `push`, `pull_request`, `workflow_run`, `deployment_status` (`WEBHOOK_EVENTS`, `apps/cloud/app/integrations/github.py:63`). Reconciliation is an outbound *poll*, which is allowed.
- **No per-template route and no per-template DB column.** A new template is a directory under `apps/cloud/app/deployments/templates/`, one `BUILTIN_TEMPLATES` entry, and optionally one `PROVIDERS` entry.
- **`stack` never dispatches.** It is a display string. `delivery_kind` is the only new discriminator.
- **`embeddable` stays measured, not trusted.** The registry's claim narrows what the platform attempts; `_probe_frame_policy` decides what it does.
- **The cloud never writes task status.** ADR 0022 keeps status with the client that observed publication. The cloud writes attribution (`Artifact`) only.
- **No Git vocabulary reaches a non-admin member** in the Preview tab: no SHA, branch, workflow name or run URL. Version ordinal, relative time, task list, state only. Those fields stay, behind the workspace-admin gate.
- **Attacker-influenced input.** `environment_url` and every manifest URL arrive from a workflow editable by anyone with push access. They stay subject to: the `http(s)`-only scheme check (`_is_web_url`), the platform-prefix check (`_trusted_environment_url`), and the SSRF guard on any URL the cloud itself fetches (`_probe_target_is_public`).
- **Migrations are append-only.** Never edit an applied file — `pz_schema_migrations` (0024) checksums them. Next free numbers are `0027`, `0028`, `0029`.
- **`acceptance_criteria` stays `{text: string}[]`.** Never flatten.
- **Prose-forward docs.** ADRs and guides are paragraphs, not bullet dumps.
- **Python style:** `from __future__ import annotations`, `X | None` unions, ruff `E,F,I,UP,B` at line-length 100. Run `ruff check .` from `apps/cloud` before every commit.
- **Test commands:** `cd apps/cloud && pytest` · `pnpm --dir apps/web test` (vitest) · `pnpm --dir apps/web typecheck`.

## File Structure

**New files (cloud)**

| Path | Responsibility |
|---|---|
| `apps/cloud/app/integrations/task_refs.py` | The one commit-subject → task-ref rule, ported from `apps/vscode/src/git/taskRefs.ts`. Pure. |
| `apps/cloud/app/deployments/reconcile.py` | Outbound sweep closing out non-terminal deployments the webhook never finished. |
| `apps/cloud/app/deployments/attribution.py` | Resolving and freezing a build's task set at terminal state. |
| `apps/cloud/app/deployments/manifest.py` | Build-manifest schema, strict validator and size-capped fetch. |
| `apps/cloud/app/deployments/retention.py` | Ensuring the R2 lifecycle rule on each minted workspace bucket. |
| `apps/cloud/app/deployments/templates/fly-node/**` | Second template: containerized Node service on a customer-owned provider. |
| `apps/cloud/app/deployments/templates/desktop-r2/**` | `artifact_download`: desktop installers + build manifest. |
| `apps/cloud/app/deployments/templates/android-r2/**` | `artifact_download`: APK + build manifest. |
| `apps/cloud/app/deployments/templates/api-node/**` | `api_console`: Node API publishing an OpenAPI document. |
| `apps/cloud/app/deployments/templates/testflight/**`, `play-internal/**` | `store_build`. |
| `apps/cloud/migrations/0027_deployment_tasks.sql` | `pz_deployment_tasks`. |
| `apps/cloud/migrations/0028_deployment_assets.sql` | `pz_deployments.assets`. |

**New files (web)**

| Path | Responsibility |
|---|---|
| `apps/web/src/components/project/BuildTasks.tsx` | "What's in this build" list + per-task comment affordance. |
| `apps/web/src/components/project/BuildHistory.tsx` | Version list from `recent[]`. |
| `apps/web/src/components/project/DownloadCard.tsx` | `artifact_download` + `store_build` renderings. |
| `apps/web/src/components/project/ApiConsole.tsx` | `api_console` rendering: operation list + read-only request console. |

**Modified (cloud):** `app/deployments/registry.py` · `app/integrations/deploy_providers.py` · `app/integrations/github.py` · `app/api/github.py` · `app/api/deployments.py` · `app/api/sync.py` · `app/models/schemas.py` · `app/db/repository.py` · `app/db/supabase_repository.py` · `app/config.py` · `app/main.py`

**Modified (web):** `src/lib/types.ts` · `src/lib/api.ts` · `src/components/project/PreviewPanel.tsx` · `previewState.ts` · `ProgressRollup.tsx` · `TaskBoard.tsx` · `src/app/w/[workspaceId]/p/[projectId]/page.tsx`

---

# Phase 1 — Prove the contract

Nothing in the task graph changes. Phases 1 and 2 are independent and may run in parallel.

---

### Task 1: `delivery_kind` on the Deployment Template

Add the discriminator with a default that makes every existing path byte-identical.

**Files:**
- Modify: `apps/cloud/app/deployments/registry.py` (dataclass `DeploymentTemplate`, ~line 100)
- Modify: `apps/cloud/app/api/deployments.py` (`DeploymentTemplateOut`, ~line 51)
- Modify: `apps/web/src/lib/types.ts` (`DeploymentTemplateOut`, ~line 365)
- Test: `apps/cloud/tests/test_deployment_templates.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `DeploymentTemplate.delivery_kind: str` (default `"embedded_url"`); module constant `DELIVERY_KINDS: frozenset[str]`; `DeploymentTemplateOut.delivery_kind: str` on `GET /deployment-templates`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cloud/tests/test_deployment_templates.py`:

```python
from app.deployments.registry import BUILTIN_TEMPLATES, DELIVERY_KINDS, get_template


def test_every_builtin_declares_a_known_delivery_kind():
    for template in BUILTIN_TEMPLATES:
        assert template.delivery_kind in DELIVERY_KINDS, template.id


def test_static_r2_still_presents_as_an_embedded_url():
    # ADR 0023 phase 1: behaviour must be byte-identical for existing projects.
    assert get_template("static-r2").delivery_kind == "embedded_url"


def test_delivery_kind_is_on_the_templates_endpoint(client):
    rows = client.get("/deployment-templates", headers={"X-User-Id": "alice"}).json()
    assert {r["id"]: r["delivery_kind"] for r in rows}["static-r2"] == "embedded_url"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_deployment_templates.py -k delivery -v`
Expected: FAIL with `ImportError: cannot import name 'DELIVERY_KINDS'`

- [ ] **Step 3: Add the discriminator**

In `apps/cloud/app/deployments/registry.py`, above `BUILTIN_TEMPLATES`:

```python
# How the platform PRESENTS a build. The one new dispatch key ADR 0023 adds,
# and deliberately not `stack`: `stack` stays a display string so a template
# can never grow a per-stack special case in the cloud.
#
#   embedded_url      a web page the platform frames
#   external_url      a web page that refuses framing, opened in its own tab
#   api_console       an HTTP API; the build publishes an OpenAPI document
#   artifact_download a file a person installs (installer, APK, .app archive)
#   store_build       reaches its audience through TestFlight / a Play track
DELIVERY_KINDS = frozenset(
    {"embedded_url", "external_url", "api_console", "artifact_download", "store_build"}
)
```

In the `DeploymentTemplate` dataclass, immediately after `stack`:

```python
    # ADR 0023. Defaults to embedded_url so every template written before this
    # field existed keeps exactly its previous presentation.
    delivery_kind: str = "embedded_url"
```

- [ ] **Step 4: Surface it on the API and the web type**

`apps/cloud/app/api/deployments.py` — add to `DeploymentTemplateOut` after `stack: str`:

```python
    # embedded_url | external_url | api_console | artifact_download | store_build
    delivery_kind: str
```

and in `list_deployment_templates`, inside the `DeploymentTemplateOut(...)` call after `stack=template.stack,`:

```python
                delivery_kind=template.delivery_kind,
```

`apps/web/src/lib/types.ts` — add to `DeploymentTemplateOut` after `stack: string;`:

```ts
  // ADR 0023: decides how the Preview tab presents this project's build.
  delivery_kind:
    | "embedded_url"
    | "external_url"
    | "api_console"
    | "artifact_download"
    | "store_build";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd apps/cloud && pytest tests/test_deployment_templates.py -v && ruff check .`
Expected: PASS
Run: `pnpm --dir apps/web typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/deployments/registry.py apps/cloud/app/api/deployments.py \
        apps/cloud/tests/test_deployment_templates.py apps/web/src/lib/types.ts
git commit -m "feat(deployments): declare a delivery_kind on every deployment template"
```

---

### Task 2: Connect a customer-owned deploy provider

`resolve_provider_credential` already reads `Workspace.integration_config[provider_id]`, but nothing ever writes it for a customer-owned provider — only the platform-R2 minting path does. This is the missing half.

**Files:**
- Modify: `apps/cloud/app/integrations/deploy_providers.py` (add the `fly` provider + its verifier)
- Modify: `apps/cloud/app/api/deployments.py` (three routes)
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/lib/types.ts`
- Test: `apps/cloud/tests/test_deploy_providers.py` (new)

**Interfaces:**
- Consumes: `provider_config()`, `resolve_provider_credential()`, `PROVIDERS`, `DeployProvider`, `CredentialField`, `ProviderCredentialError` from `app/integrations/deploy_providers.py`.
- Produces:
  - `GET  /workspaces/{workspace_id}/integrations/deploy/{provider_id}` → `DeployConnectionOut{connected: bool, provider: str, label: str, fields: list[CredentialFieldOut], values: dict[str,str], connected_at: str | None}`
  - `PUT  /workspaces/{workspace_id}/integrations/deploy/{provider_id}` body `DeployConnectRequest{token: str, values: dict[str,str]}` → `DeployConnectionOut`
  - `DELETE /workspaces/{workspace_id}/integrations/deploy/{provider_id}` → `DeployConnectionOut`
  - `PROVIDERS["fly"]` with `fields = (CredentialField("app_name", "Fly application name"), CredentialField("org_slug", "Fly organisation"))`

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_deploy_providers.py`:

```python
"""Connecting a customer-owned deployment provider (ADR 0023 phase 1).

The platform-owned R2 provider needs no connection; every other provider is a
token a workspace admin supplies, verified before storage exactly like the
GitHub PAT (app/api/github.py::connect_github).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.integrations import deploy_providers
from app.main import create_app
from app.models.schemas import Role

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        yield c


def _workspace(client: TestClient, *, member: str | None = None) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    if member:
        client.app.state.repository.add_member(ws["id"], member, Role.member, invited_by="alice")
    return ws["id"]


@pytest.fixture
def accepting_fly(monkeypatch):
    """Network-free verifier, the same seam FakeGithubClient gives the PAT."""
    calls: list[dict] = []

    async def verify(app, config):
        calls.append(config)
        return {}

    monkeypatch.setitem(
        deploy_providers.PROVIDERS,
        "fly",
        deploy_providers.PROVIDERS["fly"].__class__(
            id="fly",
            label="Fly.io",
            fields=deploy_providers.PROVIDERS["fly"].fields,
            verify=verify,
        ),
    )
    return calls


def test_an_admin_connects_a_provider(client, accepting_fly):
    ws = _workspace(client)
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "fly-token", "values": {"app_name": "rocket", "org_slug": "acme"}},
        headers=ALICE,
    )
    assert res.status_code == 200
    assert res.json()["connected"] is True
    assert accepting_fly == [{"token": "fly-token", "app_name": "rocket", "org_slug": "acme"}]


def test_the_token_is_never_returned_and_never_stored_in_the_clear(client, accepting_fly):
    ws = _workspace(client)
    client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "fly-token", "values": {"app_name": "rocket", "org_slug": "acme"}},
        headers=ALICE,
    )
    body = client.get(f"/workspaces/{ws}/integrations/deploy/fly", headers=ALICE).json()
    assert "fly-token" not in str(body)
    stored = client.app.state.repository.get_workspace(ws).integration_config["fly"]
    assert "fly-token" not in str(stored)
    assert stored["secret_ref"]


def test_a_rejected_token_is_not_stored(client, monkeypatch):
    async def verify(app, config):
        raise deploy_providers.ProviderCredentialError("deploy_token_rejected")

    monkeypatch.setitem(
        deploy_providers.PROVIDERS,
        "fly",
        deploy_providers.PROVIDERS["fly"].__class__(id="fly", label="Fly.io", verify=verify),
    )
    ws = _workspace(client)
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "bad", "values": {}},
        headers=ALICE,
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "deploy_token_rejected"
    assert "fly" not in (client.app.state.repository.get_workspace(ws).integration_config or {})


def test_a_plain_member_cannot_connect(client, accepting_fly):
    ws = _workspace(client, member="bob")
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "t", "values": {}},
        headers=BOB,
    )
    assert res.status_code == 403


def test_disconnect_clears_the_block(client, accepting_fly):
    ws = _workspace(client)
    client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "t", "values": {"app_name": "rocket", "org_slug": "acme"}},
        headers=ALICE,
    )
    res = client.delete(f"/workspaces/{ws}/integrations/deploy/fly", headers=ALICE)
    assert res.status_code == 200
    assert res.json()["connected"] is False


def test_the_platform_owned_provider_refuses_a_connection(client):
    ws = _workspace(client)
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/platform-r2",
        json={"token": "t", "values": {}},
        headers=ALICE,
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "provider_is_platform_owned"


def test_an_unknown_provider_is_404(client):
    ws = _workspace(client)
    res = client.get(f"/workspaces/{ws}/integrations/deploy/nope", headers=ALICE)
    assert res.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_deploy_providers.py -v`
Expected: FAIL — `KeyError: 'fly'` in the fixture, then 404s from the missing routes.

- [ ] **Step 3: Add the `fly` provider and its verifier**

In `apps/cloud/app/integrations/deploy_providers.py`, after the `PLATFORM_R2` constant:

```python
FLY = "fly"
```

and after `provider_config()` (before the platform-R2 section), the verifier:

```python
async def verify_fly_token(app, config: dict) -> dict:
    """Confirm a Fly.io deploy token can see the organisation before we store it.

    Same reasoning as `connect_github`'s verification: a token that cannot
    reach the org produces a workspace that looks connected in settings and
    fails at tech-review exit, in front of a Tech Lead who cannot tell why.
    """
    import httpx

    token = config.get("token") or ""
    org = config.get("org_slug") or "personal"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(
                "https://api.machines.dev/v1/apps",
                params={"org_slug": org},
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception as exc:  # noqa: BLE001 - transport failures included
        raise ProviderCredentialError("deployment_provider_unreachable") from exc
    if resp.status_code in (401, 403):
        raise ProviderCredentialError("deploy_token_rejected")
    if resp.is_error:
        raise ProviderCredentialError("deployment_provider_unreachable")
    return {}
```

Add the entry to `PROVIDERS`:

```python
    FLY: DeployProvider(
        id=FLY,
        label="Fly.io",
        fields=(
            CredentialField("app_name", "Fly application name"),
            CredentialField("org_slug", "Fly organisation"),
        ),
        verify=verify_fly_token,
        notes=(
            "Create a deploy token in the Fly dashboard (Tokens → Deploy token) "
            "scoped to this application, not an account-wide personal token.",
            "The application must exist before the first deploy: run "
            "`flyctl apps create <name>` once.",
        ),
    ),
```

- [ ] **Step 4: Add the three routes**

In `apps/cloud/app/api/deployments.py`, extend the imports:

```python
from app.integrations.deploy_providers import (
    PLATFORM_R2,
    PROVIDERS,
    ProviderCredentialError,
    get_provider,
    provider_config,
)
from app.models.schemas import utcnow
```

and append:

```python
class CredentialFieldOut(BaseModel):
    name: str
    label: str
    secret: bool


class DeployConnectionOut(BaseModel):
    """Non-secret connection status. The token is never echoed — the only
    readable proof it exists is `connected`."""

    connected: bool
    provider: str
    label: str
    fields: list[CredentialFieldOut]
    # The non-secret identifiers the admin supplied (app name, org slug).
    values: dict[str, str]
    connected_at: str | None


class DeployConnectRequest(BaseModel):
    token: str
    values: dict[str, str] = {}


def _deploy_connection_out(provider, config: dict | None) -> DeployConnectionOut:
    fields = [CredentialFieldOut(name=f.name, label=f.label, secret=f.secret) for f in provider.fields]
    return DeployConnectionOut(
        connected=config is not None,
        provider=provider.id,
        label=provider.label,
        fields=fields,
        values={f.name: (config or {}).get(f.name, "") for f in provider.fields},
        connected_at=(config or {}).get("connected_at"),
    )


def _require_connectable_provider(provider_id: str):
    provider = get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="unknown_provider")
    if provider.platform_owned:
        # There is nothing for an admin to connect: the platform mints this
        # credential itself, per workspace and bucket-scoped.
        raise HTTPException(status_code=400, detail="provider_is_platform_owned")
    return provider


@router.get(
    "/workspaces/{workspace_id}/integrations/deploy/{provider_id}",
    response_model=DeployConnectionOut,
)
def get_deploy_connection(
    workspace_id: str,
    provider_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DeployConnectionOut:
    require_admin(repo, workspace_id, user)
    provider = get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="unknown_provider")
    return _deploy_connection_out(provider, provider_config(repo.get_workspace(workspace_id), provider_id))


@router.put(
    "/workspaces/{workspace_id}/integrations/deploy/{provider_id}",
    response_model=DeployConnectionOut,
)
async def connect_deploy_provider(
    workspace_id: str,
    provider_id: str,
    body: DeployConnectRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DeployConnectionOut:
    """Verify against the provider, then store the token encrypted.

    Verify-before-store, and store nothing at all on rejection: a half-written
    credential is worse than an absent one, because the workspace looks
    connected.
    """
    require_admin(repo, workspace_id, user)
    provider = _require_connectable_provider(provider_id)
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=422, detail="token_required")

    values = {f.name: (body.values.get(f.name) or "").strip() for f in provider.fields}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise HTTPException(status_code=422, detail="provider_fields_required")

    if provider.verify is not None:
        try:
            await provider.verify(request.app, {"token": token, **values})
        except ProviderCredentialError as exc:
            raise HTTPException(status_code=400, detail=exc.detail) from exc

    ws = repo.get_workspace(workspace_id)
    merged = dict(ws.integration_config) if ws else {}
    merged[provider_id] = {
        **values,
        "secret_ref": request.app.state.secret_store.encrypt(token),
        "connected_by": user.id,
        "connected_at": utcnow().isoformat(),
    }
    repo.update_workspace(workspace_id, integration_config=merged)
    return _deploy_connection_out(provider, merged[provider_id])


@router.delete(
    "/workspaces/{workspace_id}/integrations/deploy/{provider_id}",
    response_model=DeployConnectionOut,
)
def disconnect_deploy_provider(
    workspace_id: str,
    provider_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DeployConnectionOut:
    require_admin(repo, workspace_id, user)
    provider = _require_connectable_provider(provider_id)
    ws = repo.get_workspace(workspace_id)
    merged = dict(ws.integration_config) if ws else {}
    merged.pop(provider_id, None)
    repo.update_workspace(workspace_id, integration_config=merged)
    return _deploy_connection_out(provider, None)
```

Note the unused-import guard: `PROVIDERS` and `PLATFORM_R2` are only needed if the picker later lists providers — drop them from the import if ruff flags F401.

- [ ] **Step 5: Add the web client functions**

`apps/web/src/lib/types.ts`:

```ts
// A deployment provider a workspace admin connects (ADR 0023). The token is
// never returned — `connected` is the only readable proof it exists.
export interface DeployConnection {
  connected: boolean;
  provider: string;
  label: string;
  fields: { name: string; label: string; secret: boolean }[];
  values: Record<string, string>;
  connected_at: string | null;
}
```

`apps/web/src/lib/api.ts`:

```ts
// Admin-only on the server. Verified against the provider before storage, so
// a 400 here means the provider rejected the token, not that we did.
export function getDeployConnection(
  workspaceId: string,
  providerId: string,
  authHeaders: Record<string, string>,
) {
  return apiFetch<DeployConnection>(
    `/workspaces/${workspaceId}/integrations/deploy/${providerId}`,
    authHeaders,
  );
}

export function connectDeployProvider(
  workspaceId: string,
  providerId: string,
  body: { token: string; values: Record<string, string> },
  authHeaders: Record<string, string>,
) {
  return apiFetch<DeployConnection>(
    `/workspaces/${workspaceId}/integrations/deploy/${providerId}`,
    authHeaders,
    { method: "PUT", body: JSON.stringify(body) },
  );
}
```

Add `DeployConnection` to the existing type import list at the top of `api.ts`.

- [ ] **Step 6: Run tests**

Run: `cd apps/cloud && pytest tests/test_deploy_providers.py -v && ruff check .`
Expected: PASS
Run: `pnpm --dir apps/web typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/cloud/app/integrations/deploy_providers.py apps/cloud/app/api/deployments.py \
        apps/cloud/tests/test_deploy_providers.py apps/web/src/lib/api.ts apps/web/src/lib/types.ts
git commit -m "feat(deployments): connect a customer-owned deploy provider per workspace"
```

---

### Task 3: The second template — a containerized Node service on Fly.io

ADR 0021 asked for a second template before the contract could be called proven. This one exercises `provider_credential_kind`, `url_kind == "provider"` and the customer-credential path that `static-r2` never touches.

**Files:**
- Create: `apps/cloud/app/deployments/templates/fly-node/.github/workflows/deploy.yml.tmpl`
- Create: `apps/cloud/app/deployments/templates/fly-node/Dockerfile`
- Create: `apps/cloud/app/deployments/templates/fly-node/fly.toml`
- Create: `apps/cloud/app/deployments/templates/fly-node/package.json.tmpl`
- Create: `apps/cloud/app/deployments/templates/fly-node/server.js`
- Create: `apps/cloud/app/deployments/templates/fly-node/public/index.html`
- Modify: `apps/cloud/app/deployments/registry.py` (`BUILTIN_TEMPLATES`)
- Test: `apps/cloud/tests/test_repo_seed.py`

**Interfaces:**
- Consumes: `SecretSpec`, `VarSpec`, `DeploymentTemplate` (Task 1's `delivery_kind`), `PROVIDERS["fly"]` (Task 2).
- Produces: `get_template("fly-node")` with `provider="fly"`, `provider_credential_kind="fly"`, `url_kind="provider"`, `delivery_kind="embedded_url"`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cloud/tests/test_repo_seed.py`:

```python
from app.deployments.registry import get_template, template_files
from app.integrations.deploy_providers import PROVIDERS


def test_fly_node_is_a_customer_owned_provider_template():
    template = get_template("fly-node")
    assert template is not None
    # The point of the second template: it exercises the paths static-r2 never
    # touches — a customer credential and a provider-minted URL.
    assert template.provider_credential_kind == "fly"
    assert template.url_kind == "provider"
    assert template.provider in PROVIDERS


def test_fly_node_seeds_a_dockerfile_and_the_fixed_workflow_path():
    paths = {path for path, _, _ in template_files("fly-node")}
    assert "Dockerfile" in paths
    assert ".github/workflows/deploy.yml" in paths
    assert "fly.toml" in paths


def test_fly_node_reports_its_own_url_and_opens_a_deployment_first():
    workflow = next(
        content for path, content, _ in template_files("fly-node")
        if path == ".github/workflows/deploy.yml"
    )
    # Opening the deployment before the build is what lets the Preview tab show
    # "building" immediately instead of nothing until the deploy finishes.
    assert workflow.index("Open deployment") < workflow.index("flyctl deploy")
    assert "environment_url" in workflow
    # A pull request must never reach the deploy credential.
    assert "pull_request_target" not in workflow
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_repo_seed.py -k fly_node -v`
Expected: FAIL with `assert template is not None`

- [ ] **Step 3: Write the scaffold**

`apps/cloud/app/deployments/templates/fly-node/server.js`:

```js
// Minimal Node service. Replace it with your application — the pipeline around
// it (Dockerfile, fly.toml, .github/workflows/deploy.yml) is what PromptZone
// seeded, and it does not care what this file grows into.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 8080;
// Set as a Fly secret by the deploy workflow. Naming the PromptZone web origin
// as a frame ancestor is what lets the project's Preview tab embed this app
// instead of falling back to a link card.
const WEB_ORIGIN = process.env.PZ_WEB_ORIGIN || "";

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

http
  .createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = path.join(process.cwd(), "public", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
      if (WEB_ORIGIN) headers["content-security-policy"] = `frame-ancestors ${WEB_ORIGIN}`;
      res.writeHead(200, headers);
      res.end(body);
    });
  })
  .listen(PORT, "0.0.0.0");
```

`apps/cloud/app/deployments/templates/fly-node/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your application</title>
  </head>
  <body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 40rem">
    <h1>Your application is running.</h1>
    <p>
      This is the placeholder PromptZone seeded. Every push to the default branch
      rebuilds this container and republishes it, and the project's Preview tab
      shows whatever is here.
    </p>
    <script>
      // Positive proof to the PromptZone Preview tab that this page rendered
      // inside the frame. Without it the tab cannot distinguish an embedded
      // page from a blocked one, and falls back to a link card.
      if (window.parent !== window) window.parent.postMessage({ pz: "preview-ready" }, "*");
    </script>
  </body>
</html>
```

`apps/cloud/app/deployments/templates/fly-node/package.json.tmpl`:

```json
{
  "name": "preview-service",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js"
  }
}
```

`apps/cloud/app/deployments/templates/fly-node/Dockerfile`:

```dockerfile
# Containerised on purpose: this template exists to prove the deployment
# contract works for a service, not only for a static bundle.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
```

`apps/cloud/app/deployments/templates/fly-node/fly.toml`:

```toml
# The application name is written by the deploy workflow from the FLY_APP
# repository variable, so this file needs no edit when you rename the app.
primary_region = "sin"

[build]

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "get"
  path = "/healthz"
  timeout = "5s"
```

`apps/cloud/app/deployments/templates/fly-node/.github/workflows/deploy.yml.tmpl`:

```yaml
# Builds this repository's container and deploys it to your Fly.io application,
# then reports the result back as a GitHub Deployment. PromptZone reads that
# deployment over this repository's webhook and shows the running service in
# the project's Preview tab.
#
# This file belongs to you. Edit it freely — PromptZone seeded it once at
# repository creation and does not overwrite it.

name: Deploy preview

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # Build-only check for pull requests, with NO access to the deploy
  # credentials: this job never references `secrets.`. Never convert it to
  # `pull_request_target`.
  check:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - name: Build the container
        run: docker build -t preview-check .

  deploy:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: superfly/flyctl-actions/setup-flyctl@master

      # Opened first so the Preview tab can show "building" while the image
      # builds, instead of showing nothing until the deploy finishes.
      - name: Open deployment
        id: open
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          SHA: ${{ github.sha }}
          ENVIRONMENT: ${{ vars.PZ_ENVIRONMENT }}
        run: |
          set -euo pipefail
          deployment_id=$(gh api "repos/$REPO/deployments" \
            -f ref="$SHA" \
            -f environment="$ENVIRONMENT" \
            -f description="PromptZone preview" \
            -F auto_merge=false \
            -F transient_environment=false \
            -f 'required_contexts[]' \
            --jq '.id')
          echo "id=$deployment_id" >> "$GITHUB_OUTPUT"
          gh api "repos/$REPO/deployments/$deployment_id/statuses" \
            -f state=in_progress \
            -f description="Building and deploying" >/dev/null

      - name: Publish the web origin the preview is framed from
        shell: bash
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          FLY_APP: ${{ vars.FLY_APP }}
          WEB_ORIGIN: ${{ vars.PZ_WEB_ORIGIN }}
        run: flyctl secrets set PZ_WEB_ORIGIN="$WEB_ORIGIN" --app "$FLY_APP" --stage

      - name: Deploy
        id: fly
        shell: bash
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          FLY_APP: ${{ vars.FLY_APP }}
        run: |
          set -euo pipefail
          flyctl deploy --remote-only --app "$FLY_APP" --wait-timeout 600
          echo "url=https://$FLY_APP.fly.dev/" >> "$GITHUB_OUTPUT"

      # `always()` so a failed deploy still reports a terminal state. Without
      # it a broken build looks like a preview that is forever building.
      - name: Report deployment result
        if: always() && steps.open.outputs.id != ''
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          DEPLOYMENT_ID: ${{ steps.open.outputs.id }}
          PREVIEW_URL: ${{ steps.fly.outputs.url }}
          ENVIRONMENT: ${{ vars.PZ_ENVIRONMENT }}
          JOB_STATUS: ${{ job.status }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          if [ "$JOB_STATUS" = "success" ]; then
            state=success
            description="Preview deployed"
          else
            state=failure
            description="Preview deploy failed"
          fi
          gh api "repos/$REPO/deployments/$DEPLOYMENT_ID/statuses" \
            -f state="$state" \
            -f environment="$ENVIRONMENT" \
            -f environment_url="$PREVIEW_URL" \
            -f log_url="$RUN_URL" \
            -f description="$description" >/dev/null
```

- [ ] **Step 4: Register the template**

Append to `BUILTIN_TEMPLATES` in `apps/cloud/app/deployments/registry.py`:

```python
    DeploymentTemplate(
        id="fly-node",
        name="Node service → Fly.io",
        description=(
            "A containerised Node service deployed to your own Fly.io account. "
            "Bring a Fly deploy token; the pipeline builds the image and "
            "publishes it on every push to the default branch."
        ),
        stack="node",
        delivery_kind="embedded_url",
        provider="fly",
        # Customer-owned, unlike static-r2: this is the path that proves a
        # template can carry a credential the platform does not mint.
        provider_credential_kind="fly",
        scaffold_dir="fly-node",
        required_secrets=(
            SecretSpec("FLY_API_TOKEN", "Fly.io deploy token", from_provider="token"),
        ),
        required_vars=(
            VarSpec("FLY_APP", "Fly application name", "provider:app_name"),
            # The seeded server sends `frame-ancestors <origin>`; a variable
            # rather than a baked-in file so a web-app origin change is one API
            # call, not a commit to every repository ever created.
            VarSpec("PZ_WEB_ORIGIN", "PromptZone web origin", "web_origin"),
            VarSpec("PZ_PROJECT_ID", "PromptZone project id", "project_id"),
            VarSpec("PZ_ENVIRONMENT", "Deployment environment", "environment"),
        ),
        embeddable=True,
        health_path="/",
        # Fly mints the hostname, so the URL arrives with the deployment_status
        # delivery rather than being computed by the platform up front.
        url_kind="provider",
        notes=(
            "Create the Fly application once with `flyctl apps create <name>`; "
            "the pipeline deploys to it but does not create it.",
            "Fly bills this application to your own account.",
        ),
    ),
```

- [ ] **Step 5: Run tests**

Run: `cd apps/cloud && pytest tests/test_repo_seed.py tests/test_deployment_templates.py -v && ruff check .`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/deployments/templates/fly-node apps/cloud/app/deployments/registry.py \
        apps/cloud/tests/test_repo_seed.py
git commit -m "feat(deployments): add the fly-node template, proving the customer-credential path"
```

---

### Task 4: Reconciliation sweep

The webhook is best-effort. A lost delivery leaves a preview reading "building" forever — tolerable for one template and a handful of pilots, not for five delivery kinds and twenty-minute mobile builds.

**Files:**
- Create: `apps/cloud/app/deployments/reconcile.py`
- Modify: `apps/cloud/app/config.py` (two settings)
- Modify: `apps/cloud/app/db/repository.py` (ABC + `InMemoryRepository`)
- Modify: `apps/cloud/app/db/supabase_repository.py`
- Modify: `apps/cloud/app/integrations/github.py` (`GithubClient` protocol, `HttpGithubClient`, `FakeGithubClient`)
- Modify: `apps/cloud/app/main.py` (lifespan task)
- Test: `apps/cloud/tests/test_deployment_reconcile.py` (new)

**Interfaces:**
- Consumes: `repo.upsert_deployment()`, `_refresh_deployment_state()` (moved — see step 3), `_DEPLOY_STATE_BY_GITHUB`, `github_auth.resolve_token()`.
- Produces:
  - `Repository.list_stale_deployments(older_than: datetime, limit: int = 50) -> list[Deployment]`
  - `GithubClient.get_deployment(token: str, repo: str, deployment_id: str) -> dict | None`
  - `GithubClient.get_workflow_run(token: str, repo: str, run_id: str) -> dict | None`
  - `app/deployments/reconcile.py::reconcile_once(app) -> int` and `reconcile_loop(app, settings)`
  - Settings `deployment_reconcile_interval_seconds: int = 300`, `deployment_stale_after_seconds: int = 1800`

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_deployment_reconcile.py`:

```python
"""The reconciliation sweep (ADR 0023 decision 7).

An outbound poll, not an inbound callback: a lost webhook delivery must not
leave a business user staring at "building" forever.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.deployments.reconcile import reconcile_once
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import Deployment, DeploymentConfig, RepoWebhook, utcnow

ALICE = {"X-User-Id": "alice"}
REPO = "acme/rocket"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _project_with_stuck_deploy(client: TestClient, *, age_minutes: int, external_key: str = "9"):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    repository.update_project_deployment_config(project["id"], DeploymentConfig(template_id="static-r2"))
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", "main")
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project["id"],
            workspace_id=ws["id"],
            secret_ref=client.app.state.secret_store.encrypt("whsec"),
        )
    )
    # A workspace GitHub PAT must resolve, or the sweep has no way to ask.
    repository.update_workspace(
        ws["id"],
        integration_config={
            "github": {"owner": "acme", "secret_ref": client.app.state.secret_store.encrypt("ghp")}
        },
    )
    stuck = repository.upsert_deployment(
        Deployment(
            workspace_id=ws["id"],
            project_id=project["id"],
            provider="platform-r2",
            template_id="static-r2",
            external_key=external_key,
            state="building",
        )
    )
    aged = stuck.model_copy(update={"updated_at": utcnow() - timedelta(minutes=age_minutes)})
    repository._deployments[project["id"]][external_key] = aged
    return project["id"]


@pytest.mark.anyio
async def test_a_stuck_deploy_is_closed_out_from_the_deployments_api(client):
    project_id = _project_with_stuck_deploy(client, age_minutes=60)
    client.app.state.github_client.deployment_states[(REPO, "9")] = {
        "state": "success",
        "environment": "preview",
        "environment_url": "https://preview.test/previews/x/index.html",
        "log_url": "https://github.com/acme/rocket/actions/runs/1",
    }
    assert await reconcile_once(client.app) == 1
    rows = client.app.state.repository.list_deployments(project_id)
    assert rows[0].state == "live"


@pytest.mark.anyio
async def test_a_recent_deploy_is_left_alone(client):
    _project_with_stuck_deploy(client, age_minutes=1)
    assert await reconcile_once(client.app) == 0


@pytest.mark.anyio
async def test_a_deploy_github_has_forgotten_is_marked_failed(client):
    project_id = _project_with_stuck_deploy(client, age_minutes=60)
    # Nothing registered for (REPO, "9") — GitHub answers 404.
    assert await reconcile_once(client.app) == 1
    rows = client.app.state.repository.list_deployments(project_id)
    assert rows[0].state == "failed"
    assert rows[0].error_code == "deploy_abandoned"


@pytest.mark.anyio
async def test_a_workflow_run_key_is_reconciled_against_the_runs_api(client):
    project_id = _project_with_stuck_deploy(client, age_minutes=60, external_key="run-42")
    client.app.state.github_client.workflow_runs[(REPO, "42")] = {
        "status": "completed",
        "conclusion": "failure",
        "html_url": "https://github.com/acme/rocket/actions/runs/42",
    }
    assert await reconcile_once(client.app) == 1
    assert client.app.state.repository.list_deployments(project_id)[0].state == "failed"
```

Add the anyio backend fixture at the top of the file if the repo has no global one:

```python
@pytest.fixture
def anyio_backend():
    return "asyncio"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_deployment_reconcile.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.deployments.reconcile'`

- [ ] **Step 3: Move `_refresh_deployment_state` where both callers can reach it**

The sweep and the webhook both need it. Cut `_refresh_deployment_state` out of `apps/cloud/app/api/github.py` into a new `apps/cloud/app/deployments/state.py`, unchanged except for its imports:

```python
"""The project's denormalized current deployment view.

Lives here rather than in the webhook router because ADR 0023's reconciliation
sweep writes deployments too, and two copies of this rule would drift.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.deployments.registry import get_template
from app.models.schemas import DeploymentState


def refresh_deployment_state(repo: Repository, project) -> None:
    """Recompute the project's denormalized current view from its rows.

    `url` is deliberately last-known-good while `state` is current: a failed
    deploy must not blank a preview that is still serving.
    """
    rows = repo.list_deployments(project.id, limit=10)
    if not rows:
        return
    latest = rows[0]
    last_good_url = next((r.url for r in rows if r.state == "live" and r.url), None)
    config = project.deployment_config
    template = get_template(config.template_id) if config else None
    repo.update_project_deployment_state(
        project.id,
        DeploymentState(
            template_id=config.template_id if config else None,
            provider=template.provider if template else None,
            state=latest.state,
            url=last_good_url,
            commit_sha=latest.commit_sha,
            run_url=latest.run_url,
        ),
    )
```

In `app/api/github.py`, delete the old function and import the new one, aliasing so the three existing call sites keep reading the same:

```python
from app.deployments.state import refresh_deployment_state as _refresh_deployment_state
```

Move `_DEPLOY_STATE_BY_GITHUB` into `app/deployments/state.py` as `DEPLOY_STATE_BY_GITHUB` and import it back the same way.

- [ ] **Step 4: Add the repository read**

`apps/cloud/app/db/repository.py`, in the abstract class beside `list_deployments`:

```python
    @abc.abstractmethod
    def list_stale_deployments(
        self, older_than: datetime, limit: int = 50
    ) -> list[Deployment]:
        """Non-terminal deployments last touched before `older_than`, oldest
        first, across every project.

        Cross-project on purpose: this backs a periodic sweep, not a request,
        and asking per project would mean walking every project every pass."""
```

`InMemoryRepository`:

```python
    def list_stale_deployments(self, older_than: datetime, limit: int = 50) -> list[Deployment]:
        rows = [
            row
            for by_key in self._deployments.values()
            for row in by_key.values()
            if row.state not in ("live", "failed", "inactive") and row.updated_at < older_than
        ]
        rows.sort(key=lambda d: (d.updated_at, d.id))
        return copy.deepcopy(rows[:limit])
```

`SupabaseRepository`:

```python
    def list_stale_deployments(self, older_than: datetime, limit: int = 50) -> list[Deployment]:
        res = (
            self._client.table(_DEPLOYMENTS)
            .select("*")
            .not_.in_("state", ["live", "failed", "inactive"])
            .lt("updated_at", older_than.isoformat())
            .order("updated_at")
            .limit(limit)
            .execute()
        )
        return [Deployment(**row) for row in (res.data or [])]
```

- [ ] **Step 5: Add the two GitHub reads**

`apps/cloud/app/integrations/github.py` — add to the `GithubClient` protocol:

```python
    async def get_deployment(self, token: str, repo: str, deployment_id: str) -> dict | None: ...

    async def get_workflow_run(self, token: str, repo: str, run_id: str) -> dict | None: ...
```

`HttpGithubClient` (place beside the other read methods):

```python
    async def get_deployment(self, token: str, repo: str, deployment_id: str) -> dict | None:
        """The newest status for one deployment, or None when GitHub has no
        such deployment (deleted, or never created by the run we recorded)."""
        resp = await _send(
            "GET",
            f"{_API}/repos/{repo}/deployments/{deployment_id}/statuses?per_page=1",
            token=token,
            what="read a deployment's statuses",
        )
        if resp.status_code == 404:
            return None
        rows = resp.json() or []
        return rows[0] if rows else None

    async def get_workflow_run(self, token: str, repo: str, run_id: str) -> dict | None:
        resp = await _send(
            "GET",
            f"{_API}/repos/{repo}/actions/runs/{run_id}",
            token=token,
            what="read a workflow run",
        )
        if resp.status_code == 404:
            return None
        return resp.json()
```

Use whatever the module already names its API base constant (`_API` here) — check the top of `HttpGithubClient` and match it; `_send` already raises `GithubWriteError` on non-2xx, so allow 404 through by checking `resp.status_code` only if `_send` is passed the module's existing "allow this status" convention. If `_send` raises on 404, catch it instead:

```python
        try:
            resp = await _send(...)
        except GithubWriteError as exc:
            if getattr(exc, "status_code", None) == 404:
                return None
            raise
```

`FakeGithubClient` — add to `__init__`:

```python
        # ADR 0023 reconciliation. Keyed (repo, id); an unregistered key is
        # GitHub answering 404, which is exactly the abandoned-deploy case.
        self.deployment_states: dict[tuple[str, str], dict] = {}
        self.workflow_runs: dict[tuple[str, str], dict] = {}
```

and the two methods:

```python
    async def get_deployment(self, token: str, repo: str, deployment_id: str) -> dict | None:
        return self.deployment_states.get((repo, deployment_id))

    async def get_workflow_run(self, token: str, repo: str, run_id: str) -> dict | None:
        return self.workflow_runs.get((repo, run_id))
```

- [ ] **Step 6: Write the sweep**

Create `apps/cloud/app/deployments/reconcile.py`:

```python
"""Reconciling deployments the webhook never finished (ADR 0023 decision 7).

An outbound poll, not an inbound callback — ADR 0021's decision 3 forbids a
second inbound channel, and this does not open one. It exists because the
webhook is best-effort by construction: one lost delivery leaves a business
user watching a preview that says "building" forever, and five delivery kinds
with twenty-minute mobile builds cannot absorb that the way one static
template could.

Deliberately conservative. A deployment GitHub still reports as in-flight is
left alone however old it is; only a terminal answer, or GitHub not knowing
the deployment at all, closes a row out.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from app.deployments.registry import PREVIEW_ENVIRONMENT, get_template
from app.deployments.state import DEPLOY_STATE_BY_GITHUB, refresh_deployment_state
from app.integrations.github_auth import resolve_token
from app.models.schemas import Deployment, utcnow

logger = logging.getLogger("promptconnext.deploy")


def _repo_full_name(repo_url: str | None) -> str | None:
    if not repo_url:
        return None
    parts = [p for p in repo_url.rstrip("/").split("/") if p]
    return f"{parts[-2]}/{parts[-1]}" if len(parts) >= 2 else None


async def _reconcile_one(app, repo, row: Deployment) -> bool:
    project = repo.get_project(row.project_id)
    if project is None:
        return False
    full_name = _repo_full_name(project.repo_url)
    if full_name is None:
        return False
    resolved = resolve_token(app, repo.get_workspace(project.workspace_id))
    if resolved is None:
        return False
    token, _config = resolved
    client = app.state.github_client

    state: str | None = None
    url = row.url
    run_url = row.run_url
    error_code = None
    error_message = None

    try:
        if row.external_key.startswith("run-"):
            run = await client.get_workflow_run(token, full_name, row.external_key[4:])
            if run is None:
                state = "failed"
                error_code = "deploy_abandoned"
            elif run.get("status") == "completed":
                conclusion = run.get("conclusion")
                run_url = run.get("html_url") or run_url
                if conclusion in ("success", "skipped"):
                    # A successful run reports itself as a deployment; nothing
                    # to close out here.
                    return False
                state = "failed"
                error_code = "build_failed"
                error_message = f"workflow run {conclusion}"
        else:
            status = await client.get_deployment(token, full_name, row.external_key)
            if status is None:
                state = "failed"
                error_code = "deploy_abandoned"
            else:
                if str(status.get("environment") or PREVIEW_ENVIRONMENT) != PREVIEW_ENVIRONMENT:
                    return False
                mapped = DEPLOY_STATE_BY_GITHUB.get(str(status.get("state") or ""))
                if mapped is None or mapped not in ("live", "failed", "inactive"):
                    # Still moving. Age is not evidence of failure.
                    return False
                state = mapped
                run_url = status.get("log_url") or status.get("target_url") or run_url
                if mapped == "failed":
                    error_code = "deploy_failed"
                    error_message = status.get("description")
                else:
                    # The URL is re-validated by the same rule the webhook path
                    # uses; see app/api/github.py::_trusted_environment_url.
                    from app.api.github import _trusted_environment_url

                    template = get_template(project.deployment_config.template_id) if project.deployment_config else None
                    url = _trusted_environment_url(
                        app, project, template, status.get("environment_url")
                    ) or url
    except Exception:  # noqa: BLE001 - a sweep must never crash the app
        logger.warning("reconciling deployment %s failed", row.id, exc_info=True)
        return False

    if state is None:
        return False

    if error_code == "deploy_abandoned":
        error_message = "The build stopped reporting and could not be found."

    repo.upsert_deployment(
        row.model_copy(
            update={
                "state": state,
                "url": url if state != "failed" else None,
                "run_url": run_url,
                "error_code": error_code,
                "error_message": error_message,
            }
        )
    )
    refresh_deployment_state(repo, repo.get_project(row.project_id))
    logger.info("reconciled deployment %s to %s", row.id, state)
    return True


async def reconcile_once(app) -> int:
    """One pass. Returns how many rows were closed out."""
    settings = app.state.settings
    repo = app.state.repository
    cutoff = utcnow() - timedelta(seconds=settings.deployment_stale_after_seconds)
    rows = repo.list_stale_deployments(cutoff)
    closed = 0
    for row in rows:
        if await _reconcile_one(app, repo, row):
            closed += 1
    return closed


async def reconcile_loop(app, settings) -> None:
    if settings.deployment_reconcile_interval_seconds <= 0:
        return
    while True:
        await asyncio.sleep(settings.deployment_reconcile_interval_seconds)
        try:
            closed = await reconcile_once(app)
            if closed:
                logger.info("Deployment reconciliation closed out %s deploy(s)", closed)
        except Exception:  # noqa: BLE001 - the sweep must never crash the app
            logger.exception("Deployment reconciliation pass failed")
```

- [ ] **Step 7: Wire the settings and the loop**

`apps/cloud/app/config.py`, beside the other deploy settings:

```python
    # ADR 0023 decision 7. The sweep is an outbound poll that closes out
    # deployments a lost webhook delivery left in flight. `stale_after` is
    # generous on purpose: a mobile build legitimately takes twenty minutes,
    # and closing one out early would be worse than closing it out late.
    deployment_reconcile_interval_seconds: int = 300
    deployment_stale_after_seconds: int = 1800
```

`apps/cloud/app/main.py` — import and start it beside the other two background tasks:

```python
    from app.deployments.reconcile import reconcile_loop

    reconcile_task = asyncio.create_task(reconcile_loop(app, settings))
```

and in the `finally` block, mirroring `gc_task`:

```python
        reconcile_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reconcile_task
```

- [ ] **Step 8: Run tests**

Run: `cd apps/cloud && pytest tests/test_deployment_reconcile.py tests/test_deployments.py -v && ruff check .`
Expected: PASS (including the pre-existing deployment tests, which must be unaffected by the `_refresh_deployment_state` move)

- [ ] **Step 9: Commit**

```bash
git add apps/cloud/app/deployments/reconcile.py apps/cloud/app/deployments/state.py \
        apps/cloud/app/api/github.py apps/cloud/app/config.py apps/cloud/app/main.py \
        apps/cloud/app/db/repository.py apps/cloud/app/db/supabase_repository.py \
        apps/cloud/app/integrations/github.py apps/cloud/tests/test_deployment_reconcile.py
git commit -m "feat(deployments): reconcile deployments a lost webhook delivery left in flight"
```

---

### Task 5: Version history, and no Git vocabulary for members

Decision 6 is a constraint on the surface, not a preference about copy. The `recent[]` the API has always returned has never been rendered; render it as versions, and move every Git term behind the workspace-admin gate.

**Files:**
- Modify: `apps/web/src/components/project/previewState.ts`
- Create: `apps/web/src/components/project/BuildHistory.tsx`
- Modify: `apps/web/src/components/project/PreviewPanel.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx` (pass `workspaceId`)
- Test: `apps/web/src/components/project/previewState.test.ts`, `PreviewPanel.test.tsx`

**Interfaces:**
- Consumes: `DeploymentStatus`, `DeploymentOut` from `@/lib/types`; `useIsWorkspaceAdmin` from `@/lib/workspace`.
- Produces:
  - `previewState.ts`: `export interface BuildVersion { id: string; ordinal: number; label: string; state: string; at: string; deploy: DeploymentOut }` and `export function buildVersions(status: DeploymentStatus | null): BuildVersion[]`, `export function relativeTime(iso: string, now?: Date): string`
  - `BuildHistory.tsx`: `export function BuildHistory({ versions, isAdmin }: { versions: BuildVersion[]; isAdmin: boolean })`
  - `PreviewPanel` gains a required prop: `export function PreviewPanel({ projectId, workspaceId }: { projectId: string; workspaceId: string })`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/project/previewState.test.ts`:

```ts
import { buildVersions, relativeTime } from "./previewState";
import type { DeploymentStatus, DeploymentOut } from "@/lib/types";

function deploy(over: Partial<DeploymentOut> = {}): DeploymentOut {
  return {
    id: "d1",
    state: "live",
    url: "https://preview.test/p/index.html",
    commit_sha: "abc1234def",
    ref: "main",
    run_url: "https://github.com/acme/rocket/actions/runs/1",
    frame_policy: "allow",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    ...over,
  };
}

function status(recent: DeploymentOut[]): DeploymentStatus {
  return {
    template_id: "static-r2",
    template_name: "T",
    provider: "platform-r2",
    embeddable: true,
    state: "live",
    url: recent[0]?.url ?? null,
    health_path: "/",
    pending: 0,
    last_deploy: recent[0] ?? null,
    recent,
    last_error: null,
  };
}

describe("buildVersions", () => {
  it("numbers oldest-first so version 1 never changes number", () => {
    const versions = buildVersions(
      status([
        deploy({ id: "d3", created_at: "2026-09-01T12:00:00Z" }),
        deploy({ id: "d2", created_at: "2026-09-01T11:00:00Z" }),
        deploy({ id: "d1", created_at: "2026-09-01T10:00:00Z" }),
      ]),
    );
    // Newest first for display, but the ordinal counts from the oldest row.
    expect(versions.map((v) => [v.id, v.ordinal])).toEqual([
      ["d3", 3],
      ["d2", 2],
      ["d1", 1],
    ]);
    expect(versions[0].label).toBe("Version 3");
  });

  it("is empty when nothing has ever deployed", () => {
    expect(buildVersions(null)).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  it("reads as plain English, never as a timestamp", () => {
    expect(relativeTime("2026-09-01T11:58:00Z", now)).toBe("2 minutes ago");
    expect(relativeTime("2026-09-01T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-08-30T12:00:00Z", now)).toBe("2 days ago");
    expect(relativeTime("2026-09-01T11:59:50Z", now)).toBe("just now");
  });
});
```

Append to `apps/web/src/components/project/PreviewPanel.test.tsx`:

```tsx
vi.mock("@/lib/workspace", () => ({ useIsWorkspaceAdmin: () => mockIsAdmin }));
let mockIsAdmin = false;

describe("git vocabulary (ADR 0023 decision 6)", () => {
  it("shows a member a version and a time, never a commit or a run link", async () => {
    mockIsAdmin = false;
    mockStatus(
      status({
        last_deploy: {
          id: "d1",
          state: "live",
          url: URL_LIVE,
          commit_sha: "abc1234def",
          ref: "main",
          run_url: "https://github.com/acme/rocket/actions/runs/1",
          frame_policy: "deny",
          created_at: "2026-09-01T10:00:00Z",
          updated_at: "2026-09-01T10:00:00Z",
        },
        recent: [],
      }),
    );
    render(<PreviewPanel projectId="p1" workspaceId="w1" />);
    await waitFor(() => expect(screen.getByText(/Open in a new tab/)).toBeInTheDocument());
    expect(screen.queryByText(/abc1234/)).not.toBeInTheDocument();
    expect(screen.queryByText(/build log/i)).not.toBeInTheDocument();
  });

  it("shows an admin the commit and the build log", async () => {
    mockIsAdmin = true;
    render(<PreviewPanel projectId="p1" workspaceId="w1" />);
    await waitFor(() => expect(screen.getByText(/build log/i)).toBeInTheDocument());
  });
});
```

(The existing `status()` helper takes `Partial<DeploymentStatus>` already; reuse it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web test -- previewState PreviewPanel`
Expected: FAIL — `buildVersions is not a function`, and `PreviewPanel` rejects the `workspaceId` prop.

- [ ] **Step 3: Add the pure functions**

Append to `apps/web/src/components/project/previewState.ts`:

```ts
import type { DeploymentOut } from "@/lib/types";

/** One entry in the version list a business user reads. */
export interface BuildVersion {
  id: string;
  /** Counts from the oldest known deploy, so a version never renumbers. */
  ordinal: number;
  label: string;
  state: string;
  at: string;
  deploy: DeploymentOut;
}

/**
 * The deploy history as versions, newest first.
 *
 * The ordinal counts from the oldest row the server returned rather than from
 * the newest, so "Version 3" keeps meaning the same build as more deploys
 * land. `recent[]` is capped server-side, so an ordinal is only stable within
 * that window — which is exactly the window this list renders.
 */
export function buildVersions(status: DeploymentStatus | null): BuildVersion[] {
  const rows = status?.recent ?? [];
  const total = rows.length;
  return rows.map((deploy, index) => {
    const ordinal = total - index;
    return {
      id: deploy.id,
      ordinal,
      label: `Version ${ordinal}`,
      state: deploy.state,
      at: deploy.created_at,
      deploy,
    };
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 minutes ago". A business user reads time, not a timestamp. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const delta = now.getTime() - then;
  if (delta < MINUTE) return "just now";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute");
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour");
  return plural(Math.floor(delta / DAY), "day");
}
```

- [ ] **Step 4: Write `BuildHistory.tsx`**

```tsx
// apps/web/src/components/project/BuildHistory.tsx
//
// The version list the deployment API has always returned as `recent[]` and
// the UI has never rendered (ADR 0023 phase 1).
//
// ADR 0023 decision 6 is enforced here rather than by convention: a member
// sees a version ordinal, a state and a relative time. The commit and the
// build log are how a Tech Lead diagnoses a red build, so they render only
// for a workspace admin.
"use client";

import type { BuildVersion } from "./previewState";
import { relativeTime } from "./previewState";

const STATE_COPY: Record<string, string> = {
  live: "Published",
  failed: "Did not publish",
  building: "Building",
  queued: "Queued",
  inactive: "Replaced by a newer version",
};

export function BuildHistory({
  versions,
  isAdmin,
}: {
  versions: BuildVersion[];
  isAdmin: boolean;
}) {
  if (versions.length === 0) return null;
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h4 className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Version history
      </h4>
      <ul className="divide-y divide-slate-100">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span className="text-sm font-medium text-slate-900">{v.label}</span>
            <span className="text-xs text-slate-500">
              {STATE_COPY[v.state] ?? v.state} · {relativeTime(v.at)}
              {isAdmin && v.deploy.commit_sha && (
                <>
                  {" · "}
                  <code className="text-slate-400">{v.deploy.commit_sha.slice(0, 7)}</code>
                </>
              )}
              {isAdmin && v.deploy.run_url && (
                <>
                  {" · "}
                  <a href={v.deploy.run_url} target="_blank" rel="noreferrer" className="underline">
                    build log
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Gate the panel's Git vocabulary and render the history**

In `apps/web/src/components/project/PreviewPanel.tsx`:

Change the signature and add the admin read:

```tsx
import { useIsWorkspaceAdmin } from "@/lib/workspace";
import { BuildHistory } from "./BuildHistory";
import { buildVersions, isPreviewReadyMessage, relativeTime, resolvePreview } from "./previewState";

export function PreviewPanel({
  projectId,
  workspaceId,
}: {
  projectId: string;
  workspaceId: string;
}) {
  const isAdmin = useIsWorkspaceAdmin(workspaceId);
```

Give `LinkCard` an `isAdmin` prop and replace its commit block:

```tsx
function LinkCard({
  url,
  status,
  reason,
  isAdmin,
}: {
  url: string;
  status: DeploymentStatus;
  reason: string | null;
  isAdmin: boolean;
}) {
  const at = status.last_deploy?.created_at;
```

```tsx
      {at && <p className="mt-1 text-xs text-slate-500">Published {relativeTime(at)}</p>}
      {/* ADR 0023 decision 6: a commit and a run link are a Tech Lead's tools,
          not a business user's. The moment a member has to understand a merge
          to read the preview, the feature has failed its stated purpose. */}
      {isAdmin && status.last_deploy?.commit_sha && (
        <p className="mt-1 text-xs text-slate-500">
          Built from commit <code>{shortSha(status.last_deploy.commit_sha)}</code>
          {status.last_deploy?.run_url && (
            <>
              {" · "}
              <a href={status.last_deploy.run_url} target="_blank" rel="noreferrer" className="underline">
                build log
              </a>
            </>
          )}
        </p>
      )}
```

Wrap the two remaining "Open the build log" links (the `failed` block and the `waiting`/`building` block) in `{isAdmin && ( … )}`, and pass `isAdmin` at the `LinkCard` call site. Finally, render the history just before the closing `</section>`:

```tsx
      <BuildHistory versions={buildVersions(status)} isAdmin={isAdmin} />
```

- [ ] **Step 6: Pass `workspaceId` at the call site**

`apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx`:

```tsx
            {tab === "Preview" && (
              <PreviewPanel projectId={projectId} workspaceId={workspaceId} />
            )}
```

- [ ] **Step 7: Run tests**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/project/BuildHistory.tsx \
        apps/web/src/components/project/previewState.ts \
        apps/web/src/components/project/previewState.test.ts \
        apps/web/src/components/project/PreviewPanel.tsx \
        apps/web/src/components/project/PreviewPanel.test.tsx \
        "apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx"
git commit -m "feat(web): render deploy history as versions and keep git vocabulary admin-only"
```

---

# Phase 2 — Attribution

The phase that delivers the request's core ask. Depends on nothing in Phase 3.

---

### Task 6: One ref rule, expressed twice

The extension matches `T` + one-to-six digits and normalises numerically; the cloud matches `\bT\d{3}\b` and compares `feature_tag.split(" ")[0]` textually. A project numbering its tasks `T12` closes tasks correctly from the editor and produces no PR linkage at all. `apps/vscode/src/git/taskRefs.ts` is the reference implementation; this is its port.

**Files:**
- Create: `apps/cloud/app/integrations/task_refs.py`
- Modify: `apps/cloud/app/integrations/github.py` (delete `_TASK_REF_RE` and `extract_task_refs`)
- Modify: `apps/cloud/app/api/github.py` (`_handle_pull_request`)
- Test: `apps/cloud/tests/test_task_refs.py` (new)
- Reference (do not modify): `apps/vscode/src/git/taskRefs.ts`, `apps/vscode/test/unit/taskRefs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, in `app/integrations/task_refs.py`:
  - `is_revert_subject(subject: str) -> bool`
  - `normalize_task_ref(raw: str | None) -> str | None`
  - `task_ref_from_feature_tag(tag: str | None) -> str | None`
  - `task_refs_in_subject(subject: str) -> list[str]`
  - `colliding_refs(feature_tags: Iterable[str | None]) -> set[str]`
  - `task_ref_from_branch(name: str | None) -> str | None`
  - `refs_for_commit(subject: str, branch_ref: str | None) -> list[str]`
  - `tasks_by_ref(tasks: Iterable[Task]) -> dict[str, str]` — ref → task id, with colliding refs omitted

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_task_refs.py`:

```python
"""The commit-subject -> task-ref rule (ADR 0023 decision 3).

One rule expressed twice, not two rules. These cases mirror
apps/vscode/test/unit/taskRefs.test.ts deliberately: if the two files ever
disagree, a project numbering its tasks T12 closes tasks from the editor and
gets no attribution from the server, which is the defect this replaces.
"""

from __future__ import annotations

import pytest

from app.integrations.task_refs import (
    colliding_refs,
    is_revert_subject,
    normalize_task_ref,
    refs_for_commit,
    task_ref_from_branch,
    task_ref_from_feature_tag,
    task_refs_in_subject,
    tasks_by_ref,
)
from app.models.schemas import Task


@pytest.mark.parametrize(
    "raw,expected",
    [("T001", "T1"), ("T01", "T1"), ("T1", "T1"), ("T012 [P]", "T12"), ("", None), (None, None)],
)
def test_normalisation_is_numeric_not_textual(raw, expected):
    assert normalize_task_ref(raw) == expected


def test_feature_tag_drops_the_parallel_marker():
    assert task_ref_from_feature_tag("T001 [P]") == "T1"


@pytest.mark.parametrize(
    "subject,expected",
    [
        ("feat: add retry T12", ["T12"]),
        ("feat: T001 and T2", ["T1", "T2"]),
        ("feat: T1 and T001 again", ["T1"]),  # de-duplicated after normalisation
        ("chore: bump to v1.2", []),
        ("fix TEST-12 tracker id", []),
        ("T1234567 is too long", []),
    ],
)
def test_subject_refs(subject, expected):
    assert task_refs_in_subject(subject) == expected


def test_a_revert_closes_nothing():
    assert is_revert_subject('Revert "feat: add retry T12"')
    assert task_refs_in_subject('Revert "feat: add retry T12"') == []
    assert refs_for_commit('Revert "feat: T12"', "T12") == []


def test_at_most_ten_refs_per_subject():
    subject = " ".join(f"T{n}" for n in range(1, 20))
    assert len(task_refs_in_subject(subject)) == 10


@pytest.mark.parametrize(
    "branch,expected",
    [
        ("T012-add-retry", "T12"),
        ("feature/t12_retry", "T12"),
        ("T12", "T12"),
        ("SPRINT12", None),
        ("TEST-12", None),
        ("release/v1.2", None),
        ("T12abc", None),
    ],
)
def test_branch_refs_are_whole_segments(branch, expected):
    assert task_ref_from_branch(branch) == expected


def test_the_subject_wins_over_the_branch():
    assert refs_for_commit("feat: T3 and T4", "T12") == ["T3", "T4"]
    assert refs_for_commit("feat: no ref here", "T12") == ["T12"]
    assert refs_for_commit("feat: no ref here", None) == []


def test_a_collision_blocks_attribution_rather_than_guessing():
    tags = ["T012", "T12", "T5"]
    assert colliding_refs(tags) == {"T12"}
    tasks = [
        Task(id="a", project_id="p", title="A", feature_tag="T012"),
        Task(id="b", project_id="p", title="B", feature_tag="T12"),
        Task(id="c", project_id="p", title="C", feature_tag="T5"),
    ]
    # T12 is ambiguous, so nothing may be attributed to it.
    assert tasks_by_ref(tasks) == {"T5": "c"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_task_refs.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.integrations.task_refs'`

- [ ] **Step 3: Write the port**

Create `apps/cloud/app/integrations/task_refs.py`:

```python
"""Commit subject -> task reference (ADR 0023 decision 3).

A port of apps/vscode/src/git/taskRefs.ts, and deliberately a *port* rather
than a second design: the extension and the server must resolve a commit to
the same task or a repository's attribution depends on which one saw the
commit first. Its test file mirrors the extension's for the same reason.

What this module does NOT do is decide task status. ADR 0022 keeps status with
the client that observed the publication, because the server cannot tell
"implemented" from "pushed" and must not guess. This is attribution only.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# `T` followed by one to six digits, on a word boundary. The engine's original
# \bT\d{3}\b could not see a project numbering its tasks T12.
_SUBJECT_REF_RE = re.compile(r"\bT(\d{1,6})\b")

# A branch name is not a sentence, so `\b` is the wrong boundary: it matches
# the "T1" inside "SPRINT12". Branch segments are delimited by /, - and _, and
# the ref must be a whole segment. Case-insensitive, unlike the subject
# pattern: a hand-typed lowercase branch is a spelling of the same ref.
_BRANCH_REF_RE = re.compile(r"(?:^|[/_-])[Tt](\d{1,6})(?=$|[/_-])")

# One subject closing eleven tasks is a pathological subject, not a workflow.
MAX_REFS_PER_COMMIT = 10

_REVERT_RE = re.compile(r'^\s*Revert\s+"')


def is_revert_subject(subject: str) -> bool:
    """Undoing work must never close a task, and must not fall through to
    branch attribution either — a revert on a task's own branch is the
    clearest possible case of "not done"."""
    return bool(_REVERT_RE.match(subject or ""))


def normalize_task_ref(raw: str | None) -> str | None:
    """"T001" | "T01" | "T1" -> "T1". None when the input holds no ref."""
    if not raw:
        return None
    match = re.match(r"\s*T(\d{1,6})\b", raw)
    if match is None:
        return None
    return f"T{int(match.group(1))}"


def task_ref_from_feature_tag(tag: str | None) -> str | None:
    """"T001 [P]" -> "T1". The cloud stores a parallel marker on the tag
    (app/generation/parsing.py::parse_task_lines), which is exactly why a
    textual comparison could never match "T12" against "T012"."""
    return normalize_task_ref(tag)


def task_refs_in_subject(subject: str) -> list[str]:
    """Refs in a commit subject, normalised, de-duplicated, order preserved."""
    if not subject or is_revert_subject(subject):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for match in _SUBJECT_REF_RE.finditer(subject):
        ref = f"T{int(match.group(1))}"
        if ref in seen:
            continue
        seen.add(ref)
        out.append(ref)
        if len(out) >= MAX_REFS_PER_COMMIT:
            break
    return out


def colliding_refs(feature_tags: Iterable[str | None]) -> set[str]:
    """Refs two distinct tasks both normalise to — a project holding both
    "T012" and "T12". Nothing may be attributed to those; the caller skips
    rather than guessing."""
    counts: dict[str, int] = {}
    for tag in feature_tags:
        ref = task_ref_from_feature_tag(tag)
        if ref is None:
            continue
        counts[ref] = counts.get(ref, 0) + 1
    return {ref for ref, n in counts.items() if n > 1}


def task_ref_from_branch(name: str | None) -> str | None:
    """The task a branch is for. At most one: a branch is for one task."""
    if not name:
        return None
    match = _BRANCH_REF_RE.search(name)
    if match is None:
        return None
    return f"T{int(match.group(1))}"


def refs_for_commit(subject: str, branch_ref: str | None) -> list[str]:
    """ADR 0022's two attribution rules, in order: a subject ref wins and may
    name several tasks; failing that the branch's own ref applies, naming
    exactly one. A revert yields nothing from either."""
    if is_revert_subject(subject):
        return []
    from_subject = task_refs_in_subject(subject)
    if from_subject:
        return from_subject
    return [branch_ref] if branch_ref else []


def tasks_by_ref(tasks: Iterable) -> dict[str, str]:
    """ref -> task id for the tasks a commit may name.

    Colliding refs are omitted entirely rather than resolved to whichever task
    was iterated first — a wrong attribution is worse than a missing one,
    because it is invisible.
    """
    rows = list(tasks)
    blocked = colliding_refs(t.feature_tag for t in rows)
    out: dict[str, str] = {}
    for task in rows:
        ref = task_ref_from_feature_tag(task.feature_tag)
        if ref is None or ref in blocked or getattr(task, "deleted_at", None) is not None:
            continue
        out[ref] = task.id
    return out
```

- [ ] **Step 4: Run the test**

Run: `cd apps/cloud && pytest tests/test_task_refs.py -v`
Expected: PASS

- [ ] **Step 5: Replace the old matcher in the PR handler**

In `apps/cloud/app/integrations/github.py`, delete `_TASK_REF_RE` and `extract_task_refs` along with the comment block above them, leaving the `WEBHOOK_EVENTS` and `_BLOB_CONCURRENCY` constants untouched.

In `apps/cloud/app/api/github.py`, drop `extract_task_refs` from the `app.integrations.github` import list and add:

```python
from app.integrations.task_refs import refs_for_commit, tasks_by_ref
```

Replace the linkage block in `_handle_pull_request`:

```python
    # Task linkage through the ported ref rule (ADR 0023 decision 3). The old
    # textual `feature_tag.split(" ")[0] in refs` compare could not match "T12"
    # against a stored "T012", so a project numbering its tasks that way got no
    # PR linkage at all while the editor closed its tasks correctly.
    by_ref = tasks_by_ref(graph.tasks)
    refs = refs_for_commit(event.title, None) or refs_for_commit(event.body, None)
    task_id = next((by_ref[ref] for ref in refs if ref in by_ref), None)
    if task_id is None:
        return
```

with `graph = repo.get_graph(project_id)` moved above it (it already is).

- [ ] **Step 6: Add the regression test for the old defect**

Append to `apps/cloud/tests/test_github_ingest.py`:

```python
def test_a_two_digit_task_ref_now_links_a_pull_request(client):
    """The defect ADR 0023 names: the editor closed T12 and the server linked
    nothing, because "T012".split(" ")[0] never equalled "T12"."""
    project_id, _ws = _project_with_webhook(client)
    client.app.state.repository.upsert_graph(
        project_id,
        GraphUpsertRequest(tasks=[Task(id="t1", project_id=project_id, title="Retry", feature_tag="T012")]),
        source="pz",
    )
    _deliver(
        client,
        "pull_request",
        {
            "action": "opened",
            "pull_request": {
                "number": 7,
                "title": "feat: add a retry T12",
                "body": "",
                "html_url": "https://github.com/acme/rocket/pull/7",
                "head": {"sha": "deadbeef"},
                "merged": False,
            },
        },
    )
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert [a.task_id for a in artifacts] == ["t1"]
```

Reuse the file's existing `_project_with_webhook` / `_deliver` helpers; if their names differ, match what the file already defines.

- [ ] **Step 7: Run the suite**

Run: `cd apps/cloud && pytest -v && ruff check .`
Expected: PASS (all existing tests, including `test_github_ingest.py`)

- [ ] **Step 8: Commit**

```bash
git add apps/cloud/app/integrations/task_refs.py apps/cloud/app/integrations/github.py \
        apps/cloud/app/api/github.py apps/cloud/tests/test_task_refs.py \
        apps/cloud/tests/test_github_ingest.py
git commit -m "fix(github): port the editor's task-ref rule to the cloud and use it for PR linkage"
```

---

### Task 7: `push` writes attribution, never status

**Files:**
- Modify: `apps/cloud/app/integrations/github.py` (`PushEvent`, `parse_push_event`)
- Modify: `apps/cloud/app/api/github.py` (`_handle_push`)
- Test: `apps/cloud/tests/test_push_attribution.py` (new)

**Interfaces:**
- Consumes: `refs_for_commit`, `tasks_by_ref` (Task 6); `repo.upsert_task_artifact(project_id, task_id, uri, commit_sha, kind, now)` — already idempotent on `(task_id, commit_sha)`.
- Produces:
  - `PushCommit(sha: str, subject: str, url: str)` dataclass
  - `PushEvent.commits: list[PushCommit]`
  - `app/api/github.py::_record_task_attribution(repo, project_id, event) -> int`

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_push_attribution.py`:

```python
"""The cloud reads task refs off push deliveries (ADR 0023 decision 3).

It writes attribution — the Artifact row that says "this commit belongs to
this task" — and never status. Status stays with the client that observed the
publication (ADR 0022), because the server cannot tell "implemented" from
"pushed".
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import GraphUpsertRequest, RepoWebhook, Task, TaskStatus

ALICE = {"X-User-Id": "alice"}
REPO = "acme/rocket"
SECRET = "whsec_test"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        yield c


def _project(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", "main")
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project["id"],
            workspace_id=ws["id"],
            secret_ref=client.app.state.secret_store.encrypt(SECRET),
        )
    )
    repository.upsert_graph(
        project["id"],
        GraphUpsertRequest(
            tasks=[
                Task(id="t1", project_id=project["id"], title="Retry", feature_tag="T012"),
                Task(id="t2", project_id=project["id"], title="Cache", feature_tag="T2"),
            ]
        ),
        source="pz",
    )
    return project["id"]


def _push(client: TestClient, commits: list[dict], *, ref: str = "refs/heads/main"):
    payload = {
        "ref": ref,
        "after": commits[-1]["id"] if commits else "0" * 40,
        "repository": {"full_name": REPO},
        "commits": commits,
    }
    raw = json.dumps(payload).encode()
    signature = "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return client.post(
        "/api/webhooks/github",
        content=raw,
        headers={
            "X-GitHub-Event": "push",
            "X-Hub-Signature-256": signature,
            "Content-Type": "application/json",
        },
    )


def _commit(sha: str, message: str) -> dict:
    return {
        "id": sha,
        "message": message,
        "url": f"https://github.com/{REPO}/commit/{sha}",
        "added": [],
        "modified": [],
        "removed": [],
    }


def test_a_commit_subject_attributes_its_commit_to_a_task(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: add a retry T12")])
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert [(a.task_id, a.commit_sha) for a in artifacts] == [("t1", "aaa111")]


def test_attribution_never_changes_task_status(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: add a retry T12")])
    task = client.app.state.repository.get_task(project_id, "t1")
    # ADR 0022: the cloud cannot distinguish implemented from pushed.
    assert task.status == TaskStatus.todo


def test_a_replayed_delivery_writes_one_artifact(client):
    project_id = _project(client)
    for _ in range(3):
        _push(client, [_commit("aaa111", "feat: T12 retry")])
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert len(artifacts) == 1


def test_one_push_of_several_commits_attributes_each(client):
    project_id = _project(client)
    _push(
        client,
        [_commit("aaa111", "feat: T12 retry"), _commit("bbb222", "feat: T2 cache")],
    )
    artifacts = client.app.state.repository.get_graph(project_id).artifacts
    assert sorted((a.task_id, a.commit_sha) for a in artifacts) == [
        ("t1", "aaa111"),
        ("t2", "bbb222"),
    ]


def test_a_revert_attributes_nothing(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", 'Revert "feat: T12 retry"')])
    assert client.app.state.repository.get_graph(project_id).artifacts == []


def test_a_push_to_another_branch_is_ignored(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: T12")], ref="refs/heads/spike")
    assert client.app.state.repository.get_graph(project_id).artifacts == []


def test_a_ref_no_task_carries_is_skipped(client):
    project_id = _project(client)
    _push(client, [_commit("aaa111", "feat: T999 something else")])
    assert client.app.state.repository.get_graph(project_id).artifacts == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_push_attribution.py -v`
Expected: FAIL — `assert [] == [("t1", "aaa111")]` (nothing writes artifacts from a push yet)

- [ ] **Step 3: Carry commit subjects on the parsed event**

In `apps/cloud/app/integrations/github.py`, above `PushEvent`:

```python
@dataclass(frozen=True)
class PushCommit:
    """One commit in a push delivery. `subject` is the first line only — the
    same thing the extension reads, and scanning the body would match issue
    references and quoted revert text."""

    sha: str
    subject: str
    url: str
```

Extend the dataclass and the parser:

```python
@dataclass(frozen=True)
class PushEvent:
    after_sha: str
    changed_paths: list[str] = field(default_factory=list)
    removed_paths: list[str] = field(default_factory=list)
    # ADR 0023: the same delivery that drives RAG re-indexing also carries the
    # subjects attribution is read from. One event, two readers.
    commits: list[PushCommit] = field(default_factory=list)
```

Inside `parse_push_event`, build the list while walking `payload["commits"]` and pass it to the constructor:

```python
    commits: list[PushCommit] = []
    for commit in payload.get("commits") or []:
        sha = commit.get("id") or ""
        if not sha:
            continue
        commits.append(
            PushCommit(
                sha=sha,
                subject=(commit.get("message") or "").split("\n", 1)[0],
                url=commit.get("url") or "",
            )
        )
        for path in commit.get("added") or []:
            path_action[path] = "changed"
        # … existing modified / removed loops unchanged …

    return PushEvent(
        after_sha=after_sha, changed_paths=changed, removed_paths=removed, commits=commits
    )
```

- [ ] **Step 4: Write attribution in the push handler**

In `apps/cloud/app/api/github.py`, at the end of `_handle_push`:

```python
    _record_task_attribution(repo, project_id, event)
```

and the function itself, below `_handle_push`:

```python
def _record_task_attribution(repo: Repository, project_id: str, event) -> int:
    """Upsert the `Artifact(task_id, commit_sha, kind="code")` row for every
    commit whose subject names a task (ADR 0023 decision 3).

    Status is deliberately untouched. ADR 0022 puts that with the client that
    observed the publication; the cloud cannot tell "implemented" from
    "pushed" and should not guess. What the cloud gains here is the ability to
    answer *which tasks are in this build* for repositories whose developers
    never install the extension, and for commits that arrive through a merge
    the extension never saw.

    `upsert_task_artifact` is idempotent on (task_id, commit_sha), so a
    redelivered webhook writes nothing new — which is the expected case, not
    the exceptional one.
    """
    by_ref = tasks_by_ref(repo.get_graph(project_id).tasks)
    if not by_ref:
        return 0
    now = utcnow()
    written = 0
    for commit in event.commits:
        # No branch fallback: a push delivery to the default branch has no
        # feature branch to read, and inferring one from `ref` would attribute
        # every merge commit to whatever task the branch was named for.
        for ref in refs_for_commit(commit.subject, None):
            task_id = by_ref.get(ref)
            if task_id is None:
                continue
            repo.upsert_task_artifact(
                project_id, task_id, commit.url, commit.sha, ArtifactKind.code, now
            )
            written += 1
    return written
```

`utcnow` and `ArtifactKind` are already imported in this module.

- [ ] **Step 5: Run tests**

Run: `cd apps/cloud && pytest tests/test_push_attribution.py tests/test_github_ingest.py -v && ruff check .`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/integrations/github.py apps/cloud/app/api/github.py \
        apps/cloud/tests/test_push_attribution.py
git commit -m "feat(github): record task attribution from push deliveries without touching status"
```

---

### Task 8: `pz_deployment_tasks`

Storing the association rather than deriving it on read is the decision: a force-push, a task reassignment or a later edit must not silently rewrite the history of what a stakeholder reviewed last Tuesday.

**Files:**
- Create: `apps/cloud/migrations/0027_deployment_tasks.sql`
- Modify: `apps/cloud/app/db/repository.py` (ABC + `InMemoryRepository`)
- Modify: `apps/cloud/app/db/supabase_repository.py`
- Test: `apps/cloud/tests/test_deployment_tasks.py` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Repository.set_deployment_tasks(deployment_id: str, task_ids: list[str]) -> None` — replaces the whole set, order preserved
  - `Repository.list_deployment_tasks(deployment_id: str) -> list[str]`

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_deployment_tasks.py`:

```python
"""The frozen build -> task set (ADR 0023 decision 4)."""

from __future__ import annotations

import pytest

from app.db.repository import InMemoryRepository


@pytest.fixture
def repo() -> InMemoryRepository:
    return InMemoryRepository()


def test_an_unknown_deployment_has_no_tasks(repo):
    assert repo.list_deployment_tasks("nope") == []


def test_the_set_round_trips_in_order(repo):
    repo.set_deployment_tasks("d1", ["t3", "t1", "t2"])
    assert repo.list_deployment_tasks("d1") == ["t3", "t1", "t2"]


def test_writing_replaces_rather_than_appends(repo):
    repo.set_deployment_tasks("d1", ["t1", "t2"])
    repo.set_deployment_tasks("d1", ["t9"])
    assert repo.list_deployment_tasks("d1") == ["t9"]


def test_sets_are_per_deployment(repo):
    repo.set_deployment_tasks("d1", ["t1"])
    repo.set_deployment_tasks("d2", ["t2"])
    assert repo.list_deployment_tasks("d1") == ["t1"]
    assert repo.list_deployment_tasks("d2") == ["t2"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_deployment_tasks.py -v`
Expected: FAIL with `AttributeError: 'InMemoryRepository' object has no attribute 'list_deployment_tasks'`

- [ ] **Step 3: Write the migration**

Create `apps/cloud/migrations/0027_deployment_tasks.sql`:

```sql
-- 0027 — Which tasks are in which build (ADR 0023 decision 4).
--
-- Apply with scripts/migrate.py; never edit this file once applied — the
-- pz_schema_migrations ledger (0024) checksums it and reports drift.
--
-- Frozen at terminal state rather than derived on read, and that is the whole
-- decision. The task set for a build is computed from the commits between it
-- and the previous successful build; a force-push, a task reassignment or a
-- later edit would silently rewrite the history of what a stakeholder
-- reviewed last Tuesday if this were a view.
--
-- `position` preserves the order the resolver produced (task order within the
-- graph), so the Preview tab's "what's in this build" list reads the same way
-- twice.

create table if not exists pz_deployment_tasks (
    deployment_id uuid not null references pz_deployments (id) on delete cascade,
    task_id uuid not null,
    position integer not null default 0,
    created_at timestamptz not null default now(),
    primary key (deployment_id, task_id)
);

create index if not exists idx_pz_deployment_tasks_deployment
    on pz_deployment_tasks (deployment_id, position);

-- No FK to pz_tasks: a task deleted after a build shipped must not take the
-- record of what shipped with it. The read path resolves titles from the
-- graph and simply omits a task it can no longer find.

alter table pz_deployment_tasks enable row level security;

drop policy if exists pz_deployment_tasks_read on pz_deployment_tasks;
-- Membership is checked through the parent deployment: every row here belongs
-- to exactly one deployment, and pz_deployments already carries workspace_id.
create policy pz_deployment_tasks_read on pz_deployment_tasks
  for select using (
    exists (
      select 1 from pz_deployments d
      where d.id = pz_deployment_tasks.deployment_id and pz_is_member(d.workspace_id)
    )
  );

-- SELECT only, matching 0026's posture: every row is written by the
-- HMAC-verified webhook path running on the service key. No member authors an
-- attribution, but members legitimately read their own project's.
grant select on pz_deployment_tasks to authenticated;
```

- [ ] **Step 4: Add the repository methods**

`apps/cloud/app/db/repository.py`, in the abstract class beside `get_latest_deployment`:

```python
    @abc.abstractmethod
    def set_deployment_tasks(self, deployment_id: str, task_ids: list[str]) -> None:
        """Replace this build's frozen task set, order preserved.

        Replace rather than append: the resolver runs once per terminal state
        and may run again after a reconciliation pass, and two passes must not
        double the list."""

    @abc.abstractmethod
    def list_deployment_tasks(self, deployment_id: str) -> list[str]:
        """The frozen task ids for one build, in the order they were stored."""
```

`InMemoryRepository.__init__`, beside `self._deployments`:

```python
        self._deployment_tasks: dict[str, list[str]] = {}
```

and the methods:

```python
    def set_deployment_tasks(self, deployment_id: str, task_ids: list[str]) -> None:
        self._deployment_tasks[deployment_id] = list(task_ids)

    def list_deployment_tasks(self, deployment_id: str) -> list[str]:
        return list(self._deployment_tasks.get(deployment_id, []))
```

`apps/cloud/app/db/supabase_repository.py`, beside `_DEPLOYMENTS`:

```python
_DEPLOYMENT_TASKS = "pz_deployment_tasks"
```

and the methods:

```python
    def set_deployment_tasks(self, deployment_id: str, task_ids: list[str]) -> None:
        self._client.table(_DEPLOYMENT_TASKS).delete().eq("deployment_id", deployment_id).execute()
        if not task_ids:
            return
        self._client.table(_DEPLOYMENT_TASKS).insert(
            [
                {"deployment_id": deployment_id, "task_id": task_id, "position": index}
                for index, task_id in enumerate(task_ids)
            ]
        ).execute()

    def list_deployment_tasks(self, deployment_id: str) -> list[str]:
        res = (
            self._client.table(_DEPLOYMENT_TASKS)
            .select("task_id,position")
            .eq("deployment_id", deployment_id)
            .order("position")
            .execute()
        )
        return [row["task_id"] for row in (res.data or [])]
```

- [ ] **Step 5: Run tests**

Run: `cd apps/cloud && pytest tests/test_deployment_tasks.py tests/test_migrate.py -v && ruff check .`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/migrations/0027_deployment_tasks.sql apps/cloud/app/db/repository.py \
        apps/cloud/app/db/supabase_repository.py apps/cloud/tests/test_deployment_tasks.py
git commit -m "feat(deployments): store which tasks are in which build"
```

---

### Task 9: Freeze the task set at terminal state

**Files:**
- Create: `apps/cloud/app/deployments/attribution.py`
- Modify: `apps/cloud/app/integrations/github.py` (two more reads on the client + fake)
- Modify: `apps/cloud/app/api/github.py` (`_handle_deployment_status`, `_handle_workflow_run`)
- Modify: `apps/cloud/app/deployments/reconcile.py` (freeze after a reconciled terminal state)
- Test: `apps/cloud/tests/test_build_attribution.py` (new)

**Interfaces:**
- Consumes: `repo.set_deployment_tasks` / `list_deployment_tasks` (Task 8); `repo.get_graph`; `github_auth.resolve_token`.
- Produces:
  - `GithubClient.compare_commits(token: str, repo: str, base: str, head: str) -> list[str]` — shas, oldest first
  - `GithubClient.list_commits(token: str, repo: str, sha: str, limit: int = 100) -> list[str]`
  - `app/deployments/attribution.py::freeze_build_tasks(app, repo, project, deployment) -> list[str]`

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_build_attribution.py`:

```python
"""Freezing a build's task set (ADR 0023 decision 4)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deployments.attribution import freeze_build_tasks
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import (
    Artifact,
    ArtifactKind,
    Deployment,
    DeploymentConfig,
    GraphUpsertRequest,
    Task,
)

ALICE = {"X-User-Id": "alice"}
REPO = "acme/rocket"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _setup(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    repository.update_project_deployment_config(project["id"], DeploymentConfig(template_id="static-r2"))
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", "main")
    repository.update_workspace(
        ws["id"],
        integration_config={
            "github": {"owner": "acme", "secret_ref": client.app.state.secret_store.encrypt("ghp")}
        },
    )
    repository.upsert_graph(
        project["id"],
        GraphUpsertRequest(
            tasks=[
                Task(id="t1", project_id=project["id"], title="Retry", feature_tag="T1"),
                Task(id="t2", project_id=project["id"], title="Cache", feature_tag="T2"),
                Task(id="t3", project_id=project["id"], title="Login", feature_tag="T3"),
            ],
            artifacts=[
                Artifact(id="a1", project_id=project["id"], task_id="t1", kind=ArtifactKind.code, uri="u", commit_sha="c1"),
                Artifact(id="a2", project_id=project["id"], task_id="t2", kind=ArtifactKind.code, uri="u", commit_sha="c2"),
                Artifact(id="a3", project_id=project["id"], task_id="t3", kind=ArtifactKind.code, uri="u", commit_sha="c3"),
            ],
        ),
        source="pz",
    )
    return repository.get_project(project["id"])


def _deploy(repository, project, *, key: str, state: str, sha: str) -> Deployment:
    return repository.upsert_deployment(
        Deployment(
            workspace_id=project.workspace_id,
            project_id=project.id,
            provider="platform-r2",
            template_id="static-r2",
            external_key=key,
            state=state,
            commit_sha=sha,
        )
    )


@pytest.mark.anyio
async def test_the_first_build_takes_every_commit_it_can_see(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c2")] = ["c1", "c2"]
    row = _deploy(repository, project, key="1", state="live", sha="c2")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t1", "t2"]
    assert repository.list_deployment_tasks(row.id) == ["t1", "t2"]


@pytest.mark.anyio
async def test_a_later_build_takes_only_what_is_new_since_the_last_good_one(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    first = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, first)

    client.app.state.github_client.comparisons[(REPO, "c1", "c3")] = ["c2", "c3"]
    second = _deploy(repository, project, key="2", state="live", sha="c3")
    assert await freeze_build_tasks(client.app, repository, project, second) == ["t2", "t3"]
    # The earlier build's record is untouched — that is the point of freezing.
    assert repository.list_deployment_tasks(first.id) == ["t1"]


@pytest.mark.anyio
async def test_a_failed_build_still_names_what_was_in_it(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="failed", sha="c1")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t1"]


@pytest.mark.anyio
async def test_an_unreachable_git_host_falls_back_to_the_head_commit(client):
    project = _setup(client)
    repository = client.app.state.repository
    # Nothing registered: the fake answers with no commits at all.
    row = _deploy(repository, project, key="1", state="live", sha="c2")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t2"]


@pytest.mark.anyio
async def test_a_build_with_no_commit_freezes_nothing(client):
    project = _setup(client)
    repository = client.app.state.repository
    row = _deploy(repository, project, key="1", state="live", sha=None)
    assert await freeze_build_tasks(client.app, repository, project, row) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_build_attribution.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.deployments.attribution'`

- [ ] **Step 3: Add the two GitHub reads**

`apps/cloud/app/integrations/github.py` — protocol:

```python
    async def compare_commits(self, token: str, repo: str, base: str, head: str) -> list[str]: ...

    async def list_commits(self, token: str, repo: str, sha: str, limit: int = 100) -> list[str]: ...
```

`HttpGithubClient`:

```python
    async def compare_commits(self, token: str, repo: str, base: str, head: str) -> list[str]:
        """The shas between two commits, oldest first, excluding `base`."""
        resp = await _send(
            "GET",
            f"{_API}/repos/{repo}/compare/{base}...{head}",
            token=token,
            what="compare two commits",
        )
        return [c["sha"] for c in (resp.json() or {}).get("commits", []) if c.get("sha")]

    async def list_commits(self, token: str, repo: str, sha: str, limit: int = 100) -> list[str]:
        """The first page of history reachable from `sha`, newest first.

        Only used for a project's very first build, which has no previous
        successful deploy to compare against. Capped rather than paginated: a
        first build reaches back to the seed commit, and a repository whose
        first deploy carries more than a hundred commits is one whose history
        predates PromptZone entirely."""
        resp = await _send(
            "GET",
            f"{_API}/repos/{repo}/commits?sha={sha}&per_page={min(limit, 100)}",
            token=token,
            what="list commits",
        )
        return [c["sha"] for c in (resp.json() or []) if c.get("sha")]
```

`FakeGithubClient.__init__`:

```python
        # ADR 0023 build attribution. Keyed (repo, base, head) and (repo, sha);
        # an unregistered key answers empty, which exercises the fallback.
        self.comparisons: dict[tuple[str, str, str], list[str]] = {}
        self.commit_lists: dict[tuple[str, str], list[str]] = {}
```

```python
    async def compare_commits(self, token: str, repo: str, base: str, head: str) -> list[str]:
        return list(self.comparisons.get((repo, base, head), []))

    async def list_commits(self, token: str, repo: str, sha: str, limit: int = 100) -> list[str]:
        return list(self.commit_lists.get((repo, sha), []))[:limit]
```

- [ ] **Step 4: Write the resolver**

Create `apps/cloud/app/deployments/attribution.py`:

```python
"""Which tasks are in this build (ADR 0023 decision 4).

The range is "commits since the previous successful build", not "commits in
this push": a build that lands three pushes' worth of work is one version to
the stakeholder reading the Preview tab, and three entries would be three lies
about what they are looking at.

Frozen, not derived. `pz_deployment_tasks` records the answer at terminal
state so a force-push, a reassignment or a later edit cannot rewrite what
somebody reviewed last Tuesday.
"""

from __future__ import annotations

import logging

from app.integrations.github_auth import resolve_token
from app.models.schemas import ArtifactKind, Deployment

logger = logging.getLogger("promptconnext.deploy")

# Terminal states worth freezing. A failed build still names what was in it —
# "the version that did not publish contained these three tasks" is exactly
# what a Tech Lead needs and a stakeholder deserves to be told.
TERMINAL_STATES = frozenset({"live", "failed"})


def _repo_full_name(repo_url: str | None) -> str | None:
    if not repo_url:
        return None
    parts = [p for p in repo_url.rstrip("/").split("/") if p]
    return f"{parts[-2]}/{parts[-1]}" if len(parts) >= 2 else None


def _previous_good_sha(repo, project_id: str, deployment: Deployment) -> str | None:
    for row in repo.list_deployments(project_id, limit=50):
        if row.id == deployment.id:
            continue
        if row.state == "live" and row.commit_sha and row.created_at <= deployment.created_at:
            return row.commit_sha
    return None


async def _commits_in_build(app, token: str, full_name: str, base: str | None, head: str) -> list[str]:
    client = app.state.github_client
    try:
        shas = (
            await client.compare_commits(token, full_name, base, head)
            if base
            else await client.list_commits(token, full_name, head)
        )
    except Exception:  # noqa: BLE001 - attribution must never fail a webhook
        logger.warning("resolving the commit range for %s failed", full_name, exc_info=True)
        shas = []
    # The head commit is always part of its own build; the fallback when the
    # host is unreachable is "at least name the commit we were told about",
    # which is honest and never wrong, only incomplete.
    if head not in shas:
        shas = [*shas, head]
    return shas


async def freeze_build_tasks(app, repo, project, deployment: Deployment) -> list[str]:
    """Resolve and persist this build's task set. Returns the task ids stored."""
    if not deployment.commit_sha:
        repo.set_deployment_tasks(deployment.id, [])
        return []

    full_name = _repo_full_name(project.repo_url)
    resolved = resolve_token(app, repo.get_workspace(project.workspace_id))
    shas: list[str] = [deployment.commit_sha]
    if full_name and resolved is not None:
        token, _config = resolved
        shas = await _commits_in_build(
            app,
            token,
            full_name,
            _previous_good_sha(repo, project.id, deployment),
            deployment.commit_sha,
        )

    in_build = set(shas)
    graph = repo.get_graph(project.id)
    # Ordered by the graph's own task order, so the list reads the same twice.
    attributed = {
        artifact.task_id
        for artifact in graph.artifacts
        if artifact.kind == ArtifactKind.code
        and artifact.commit_sha in in_build
        and artifact.deleted_at is None
    }
    task_ids = [task.id for task in graph.tasks if task.id in attributed and task.deleted_at is None]
    repo.set_deployment_tasks(deployment.id, task_ids)
    return task_ids
```

- [ ] **Step 5: Call it from every terminal-state writer**

`apps/cloud/app/api/github.py` — import and call at the end of `_handle_deployment_status`, after `_refresh_deployment_state(repo, project)`:

```python
from app.deployments.attribution import TERMINAL_STATES, freeze_build_tasks
```

```python
    if state in TERMINAL_STATES:
        row = repo.get_latest_deployment(project.id)
        if row is not None and row.external_key == event.external_key:
            await freeze_build_tasks(app, repo, project, row)
```

`_handle_workflow_run` is synchronous and writes a `failed` row. Make it `async def`, `await` the same block, and change its call site in the dispatch to `await _handle_workflow_run(request.app, repo, project, payload)` — passing `request.app` because the resolver needs `app.state`.

`apps/cloud/app/deployments/reconcile.py` — after `refresh_deployment_state(...)` in `_reconcile_one`:

```python
    if state in ("live", "failed"):
        from app.deployments.attribution import freeze_build_tasks

        await freeze_build_tasks(app, repo, repo.get_project(row.project_id), repo.get_latest_deployment(row.project_id))
```

Guard the `None` case: skip when `get_latest_deployment` returns `None` or its `external_key` differs from `row.external_key`.

- [ ] **Step 6: Run tests**

Run: `cd apps/cloud && pytest tests/test_build_attribution.py tests/test_deployments.py tests/test_deployment_reconcile.py -v && ruff check .`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/cloud/app/deployments/attribution.py apps/cloud/app/api/github.py \
        apps/cloud/app/deployments/reconcile.py apps/cloud/app/integrations/github.py \
        apps/cloud/tests/test_build_attribution.py
git commit -m "feat(deployments): freeze each build's task set when it reaches a terminal state"
```

---

### Task 10: Serve the task set with the deployment status

**Files:**
- Modify: `apps/cloud/app/api/deployments.py` (`DeploymentOut`, `_deployment_out`, `get_deployment_status`)
- Modify: `apps/web/src/lib/types.ts`
- Test: `apps/cloud/tests/test_deployments.py`

**Interfaces:**
- Consumes: `repo.list_deployment_tasks` (Task 8), `repo.get_graph`.
- Produces: `BuildTaskOut{id: str, title: str, ref: str | None}`; `DeploymentOut.tasks: list[BuildTaskOut]` on both `last_deploy` and every row of `recent[]`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cloud/tests/test_deployments.py`:

```python
def test_the_status_endpoint_names_the_tasks_in_each_build(client):
    project_id, ws_id = _project(client)
    repository = client.app.state.repository
    repository.upsert_graph(
        project_id,
        GraphUpsertRequest(
            tasks=[Task(id="t1", project_id=project_id, title="Add a retry", feature_tag="T001 [P]")]
        ),
        source="pz",
    )
    _deliver_success(client, project_id)
    row = repository.get_latest_deployment(project_id)
    repository.set_deployment_tasks(row.id, ["t1"])

    body = client.get(f"/projects/{project_id}/deployment", headers=ALICE).json()
    assert body["last_deploy"]["tasks"] == [{"id": "t1", "title": "Add a retry", "ref": "T1"}]
    assert body["recent"][0]["tasks"] == body["last_deploy"]["tasks"]


def test_a_task_deleted_after_the_build_is_simply_omitted(client):
    project_id, ws_id = _project(client)
    _deliver_success(client, project_id)
    row = client.app.state.repository.get_latest_deployment(project_id)
    client.app.state.repository.set_deployment_tasks(row.id, ["gone"])
    body = client.get(f"/projects/{project_id}/deployment", headers=ALICE).json()
    assert body["last_deploy"]["tasks"] == []
```

Reuse the file's existing project/delivery helpers; `_project` and the success delivery already exist under whatever names that file uses — match them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_deployments.py -k names_the_tasks -v`
Expected: FAIL with `KeyError: 'tasks'`

- [ ] **Step 3: Implement**

`apps/cloud/app/api/deployments.py`:

```python
from app.integrations.task_refs import task_ref_from_feature_tag


class BuildTaskOut(BaseModel):
    """One task in a build, in the platform's own vocabulary.

    Deliberately not a commit: ADR 0023 decision 6 keeps Git terms off this
    surface. `ref` is the project's own task number, which is what the task
    board already shows.
    """

    id: str
    title: str
    ref: str | None
```

Add to `DeploymentOut`:

```python
    # Frozen at terminal state (pz_deployment_tasks). Empty for a build still
    # in flight, and empty for a build whose tasks have since been deleted.
    tasks: list[BuildTaskOut] = []
```

Rewrite `_deployment_out` to take the lookup:

```python
def _deployment_out(row: Deployment, tasks_by_id: dict[str, BuildTaskOut], repo: Repository) -> DeploymentOut:
    frozen = repo.list_deployment_tasks(row.id)
    return DeploymentOut(
        id=row.id,
        state=row.state,
        url=row.url,
        commit_sha=row.commit_sha,
        ref=row.ref,
        run_url=row.run_url,
        frame_policy=row.frame_policy,
        # A task deleted after the build shipped is omitted rather than
        # rendered as a dangling id: the record of what shipped survives, the
        # thing that no longer exists does not get a name.
        tasks=[tasks_by_id[task_id] for task_id in frozen if task_id in tasks_by_id],
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )
```

In `get_deployment_status`, build the lookup once and pass it:

```python
    rows = repo.list_deployments(project_id, limit=10)
    graph = repo.get_graph(project_id)
    tasks_by_id = {
        task.id: BuildTaskOut(
            id=task.id, title=task.title, ref=task_ref_from_feature_tag(task.feature_tag)
        )
        for task in graph.tasks
        if task.deleted_at is None
    }
```

and replace the two `_deployment_out(...)` call sites with `_deployment_out(rows[0], tasks_by_id, repo)` and `[_deployment_out(r, tasks_by_id, repo) for r in rows]`.

- [ ] **Step 4: Add the web type**

`apps/web/src/lib/types.ts`:

```ts
// One task inside a build (ADR 0023). Deliberately not a commit: the Preview
// tab speaks the platform's vocabulary, not Git's.
export interface BuildTask {
  id: string;
  title: string;
  ref: string | null;
}
```

and add to `DeploymentOut`:

```ts
  // Frozen when the build reached a terminal state; empty while it is in flight.
  tasks: BuildTask[];
```

- [ ] **Step 5: Run tests**

Run: `cd apps/cloud && pytest tests/test_deployments.py -v && ruff check .`
Expected: PASS
Run: `pnpm --dir apps/web typecheck`
Expected: no errors — the existing `PreviewPanel.test.tsx` fixtures will need `tasks: []` added to any inline `DeploymentOut`; fix them.

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/api/deployments.py apps/cloud/tests/test_deployments.py \
        apps/web/src/lib/types.ts apps/web/src/components/project/PreviewPanel.test.tsx
git commit -m "feat(deployments): serve each build's frozen task set with its status"
```

---

### Task 11: "What's in this build"

**Files:**
- Create: `apps/web/src/components/project/BuildTasks.tsx`
- Create: `apps/web/src/components/project/BuildTasks.test.tsx`
- Modify: `apps/web/src/components/project/PreviewPanel.tsx`

**Interfaces:**
- Consumes: `DeploymentStatus.last_deploy.tasks` (Task 10), `relativeTime`, `buildVersions` (Task 5).
- Produces: `export function BuildTasks({ status, onDiscuss }: { status: DeploymentStatus; onDiscuss?: (taskId: string) => void })`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/project/BuildTasks.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BuildTasks } from "./BuildTasks";
import type { DeploymentStatus } from "@/lib/types";

afterEach(cleanup);

function status(tasks: { id: string; title: string; ref: string | null }[]): DeploymentStatus {
  const deploy = {
    id: "d1",
    state: "live",
    url: "https://preview.test/",
    commit_sha: "abc1234",
    ref: "main",
    run_url: "https://github.com/acme/rocket/actions/runs/1",
    frame_policy: "allow" as const,
    tasks,
    created_at: new Date(Date.now() - 120_000).toISOString(),
    updated_at: new Date(Date.now() - 120_000).toISOString(),
  };
  return {
    template_id: "static-r2",
    template_name: "T",
    provider: "platform-r2",
    embeddable: true,
    state: "live",
    url: deploy.url,
    health_path: "/",
    pending: 0,
    last_deploy: deploy,
    recent: [deploy],
    last_error: null,
  };
}

describe("BuildTasks", () => {
  it("names the tasks in the build, in the spec's words", () => {
    render(<BuildTasks status={status([{ id: "t1", title: "Add a retry to the uploader", ref: "T1" }])} />);
    expect(screen.getByText("Add a retry to the uploader")).toBeInTheDocument();
    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
    expect(screen.getByText(/2 minutes ago/)).toBeInTheDocument();
  });

  it("never shows a commit", () => {
    const { container } = render(
      <BuildTasks status={status([{ id: "t1", title: "Add a retry", ref: "T1" }])} />,
    );
    expect(container.textContent).not.toContain("abc1234");
    expect(container.textContent).not.toContain("main");
  });

  it("says so plainly when nothing is attributed", () => {
    render(<BuildTasks status={status([])} />);
    expect(screen.getByText(/no completed tasks/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/web test -- BuildTasks`
Expected: FAIL — cannot resolve `./BuildTasks`

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/project/BuildTasks.tsx
//
// "What's in this build" (ADR 0023 decision 5).
//
// The line the platform could not previously draw: a task board in one tab, a
// running application in another, and nothing connecting them. This is that
// connection, and it is deliberately written in the spec's vocabulary — a
// version ordinal, a time and task titles. No SHA, no branch, no run URL
// (decision 6).
"use client";

import type { DeploymentStatus } from "@/lib/types";
import { buildVersions, relativeTime } from "./previewState";

export function BuildTasks({
  status,
  onDiscuss,
}: {
  status: DeploymentStatus;
  /** Opens a discussion bound to this task. Absent until Phase 5. */
  onDiscuss?: (taskId: string) => void;
}) {
  const deploy = status.last_deploy;
  if (!deploy) return null;
  const version = buildVersions(status).find((v) => v.id === deploy.id);
  const label = version?.label ?? "Latest version";

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-slate-900">What&rsquo;s in this build</h4>
        <p className="text-xs text-slate-500">
          {label} · {relativeTime(deploy.created_at)}
        </p>
      </header>
      {deploy.tasks.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          This version has no completed tasks recorded against it yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {deploy.tasks.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-800">{task.title}</span>
              {onDiscuss && (
                <button
                  type="button"
                  onClick={() => onDiscuss(task.id)}
                  className="shrink-0 rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-slate-300"
                >
                  Comment
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Render it above the embed**

In `apps/web/src/components/project/PreviewPanel.tsx`, immediately after the header block and before the failure/waiting blocks:

```tsx
      {status && <BuildTasks status={status} />}
```

with `import { BuildTasks } from "./BuildTasks";` at the top.

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/project/BuildTasks.tsx \
        apps/web/src/components/project/BuildTasks.test.tsx \
        apps/web/src/components/project/PreviewPanel.tsx
git commit -m "feat(web): name the tasks inside the version a stakeholder is looking at"
```

---

### Task 12: The Progress tab answers "is it live"

"7 of 12 tasks" becomes "7 of 12 tasks, 5 of them in the version you can open".

**Files:**
- Modify: `apps/web/src/components/project/ProgressRollup.tsx`
- Create: `apps/web/src/components/project/ProgressRollup.test.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx` (pass `projectId`)

**Interfaces:**
- Consumes: `useCloudGet<DeploymentStatus>` from `@/lib/hooks`; `DeploymentStatus.recent[].tasks`.
- Produces: `export function ProgressRollup({ graph, projectId }: { graph: ProjectGraph; projectId: string })`; `export function shippedTaskIds(status: DeploymentStatus | null): Set<string>`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/project/ProgressRollup.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressRollup, shippedTaskIds } from "./ProgressRollup";
import type { DeploymentStatus, ProjectGraph } from "@/lib/types";

let mockStatus: DeploymentStatus | null = null;
vi.mock("@/lib/hooks", () => ({ useCloudGet: () => ({ data: mockStatus, error: null, loading: false }) }));

afterEach(cleanup);

const graph = {
  project: { id: "p1" },
  requirements: [{ id: "r1", title: "Uploads", status: "approved" }],
  spec_documents: [{ id: "s1", requirement_id: "r1" }],
  tasks: [
    { id: "t1", spec_id: "s1", title: "A", status: "implemented" },
    { id: "t2", spec_id: "s1", title: "B", status: "verified" },
    { id: "t3", spec_id: "s1", title: "C", status: "todo" },
  ],
  artifacts: [],
  agent_runs: [],
  discussions: [],
} as unknown as ProjectGraph;

describe("shippedTaskIds", () => {
  it("takes only tasks from builds that actually published", () => {
    const status = {
      recent: [
        { id: "d2", state: "failed", tasks: [{ id: "t9", title: "X", ref: null }] },
        { id: "d1", state: "live", tasks: [{ id: "t1", title: "A", ref: null }] },
      ],
    } as unknown as DeploymentStatus;
    expect([...shippedTaskIds(status)]).toEqual(["t1"]);
  });

  it("is empty when nothing has deployed", () => {
    expect(shippedTaskIds(null).size).toBe(0);
  });
});

describe("ProgressRollup", () => {
  it("says how many of the done tasks are in the version you can open", () => {
    mockStatus = {
      recent: [{ id: "d1", state: "live", tasks: [{ id: "t1", title: "A", ref: null }] }],
    } as unknown as DeploymentStatus;
    render(<ProgressRollup graph={graph} projectId="p1" />);
    expect(screen.getByText(/2\/3 tasks/)).toBeInTheDocument();
    expect(screen.getByText(/1 in the version you can open/)).toBeInTheDocument();
  });

  it("says nothing about builds when the project has never deployed", () => {
    mockStatus = null;
    render(<ProgressRollup graph={graph} projectId="p1" />);
    expect(screen.queryByText(/version you can open/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/web test -- ProgressRollup`
Expected: FAIL — `shippedTaskIds is not exported`

- [ ] **Step 3: Implement**

Rewrite `apps/web/src/components/project/ProgressRollup.tsx`:

```tsx
"use client";

import { useCloudGet } from "@/lib/hooks";
import type { DeploymentStatus, ProjectGraph, TaskStatus } from "@/lib/types";

const DONE: TaskStatus[] = ["implemented", "verified"];

/**
 * Tasks that are in a build that actually published (ADR 0023 decision 5).
 *
 * Only `live` rows count. A failed build's task set is real history and is
 * shown as such in the Preview tab, but "the version you can open" must mean
 * exactly that — counting a build nobody can reach would be the drift this
 * whole feature exists to avoid.
 */
export function shippedTaskIds(status: DeploymentStatus | null): Set<string> {
  const ids = new Set<string>();
  for (const deploy of status?.recent ?? []) {
    if (deploy.state !== "live") continue;
    for (const task of deploy.tasks) ids.add(task.id);
  }
  return ids;
}

export function ProgressRollup({ graph, projectId }: { graph: ProjectGraph; projectId: string }) {
  // Membership-gated on the server, same endpoint the Preview tab reads. A
  // project with no deployment simply answers "not_configured" and the build
  // clause below disappears.
  const { data: status } = useCloudGet<DeploymentStatus>(`/projects/${projectId}/deployment`);
  const shipped = shippedTaskIds(status ?? null);

  if (graph.requirements.length === 0) {
    return <p className="text-sm text-slate-500">Nothing to roll up yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {graph.requirements.map((r) => {
        const specIds = new Set(
          graph.spec_documents.filter((s) => s.requirement_id === r.id).map((s) => s.id),
        );
        const tasks = graph.tasks.filter((t) => t.spec_id && specIds.has(t.spec_id));
        const doneTasks = tasks.filter((t) => DONE.includes(t.status));
        const pct = tasks.length === 0 ? 0 : Math.round((doneTasks.length / tasks.length) * 100);
        const live = doneTasks.filter((t) => shipped.has(t.id)).length;
        return (
          <div key={r.id} className="rounded border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{r.title}</span>
              <span className="text-slate-500">
                {doneTasks.length}/{tasks.length} tasks · {pct}%
              </span>
            </div>
            <div className="mt-2 h-2 rounded bg-slate-100">
              <div className="h-2 rounded bg-slate-900" style={{ width: `${pct}%` }} />
            </div>
            {shipped.size > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                {live} in the version you can open
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Pass `projectId` at the call site**

`apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx`:

```tsx
            {tab === "Progress" && <ProgressRollup graph={graph} projectId={projectId} />}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/project/ProgressRollup.tsx \
        apps/web/src/components/project/ProgressRollup.test.tsx \
        "apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx"
git commit -m "feat(web): say how much of the done work is in the version you can open"
```

---

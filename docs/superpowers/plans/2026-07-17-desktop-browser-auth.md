# Desktop Browser-Auth Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the desktop app sign in to PromptConnext Cloud through the hosted `apps/web` auth pages, returning the Supabase session via a `promptconnext://` deep link and a short-lived one-time code brokered by `apps/cloud`.

**Architecture:** The browser owns the Supabase PKCE session, so it hands the session to `apps/cloud` (`/desktop-auth/handoff`) which mints a single-use opaque code. The browser redirects to `promptconnext://auth/callback?code=…&state=…`; the desktop deep-link handler verifies `state`, and the engine redeems the code (`/desktop-auth/redeem`) for the tokens and stores them in the OS keychain — the same slot the old password login used.

**Tech Stack:** FastAPI + pytest (cloud), Node 24 / Hono / TypeScript (engine), Next.js 16 / React 19 / supabase-js (web), Tauri 2 / Rust + `tauri-plugin-deep-link` (desktop).

## Global Constraints

- Brand name is **PromptConnext**; deep-link scheme is **`promptconnext://`** (lowercase). ADR 0014.
- Callback carries **only** the opaque `handoff_code` — never a refresh/access token in the URL.
- `handoff_code`: opaque (`secrets.token_urlsafe(32)`), **single-use** (deleted on first redeem), TTL **120 s**.
- `/desktop-auth/redeem` is intentionally **unauthenticated** (the code is the credential); returns **404** on any miss/expiry/reuse.
- Stub auth mode is **unchanged** — this work touches the supabase path only.
- Engine has **no test suite / no build step** (Node 24, native TS); engine tasks verify by `tsc --noEmit` + manual. Cloud has pytest — TDD there.
- Keychain storage path (`storeCloudSession`, slot `cloud.session`) is reused unchanged; `authHeaders`/sync loop untouched.

---

### Task 1: Cloud — one-time code store

**Files:**
- Create: `apps/cloud/app/desktop_auth_store.py`
- Test: `apps/cloud/tests/test_desktop_auth.py`

**Interfaces:**
- Produces: `HandoffStore` class with `put(refresh_token: str, access_token: str, user_id: str) -> str` (returns code) and `take(code: str) -> HandoffSession | None` (single-use, expiry-checked). `HandoffSession` is a dataclass `{refresh_token, access_token, user_id}`. Default `ttl_seconds=120`. Uses `time.monotonic()` for expiry; time injectable via constructor arg `clock` for tests.

- [ ] **Step 1: Write the failing test**

```python
# apps/cloud/tests/test_desktop_auth.py
from __future__ import annotations

from app.desktop_auth_store import HandoffStore


def test_put_then_take_returns_session():
    store = HandoffStore()
    code = store.put(refresh_token="r1", access_token="a1", user_id="alice")
    assert isinstance(code, str) and len(code) > 20
    sess = store.take(code)
    assert sess is not None
    assert (sess.refresh_token, sess.access_token, sess.user_id) == ("r1", "a1", "alice")


def test_take_is_single_use():
    store = HandoffStore()
    code = store.put("r1", "a1", "alice")
    assert store.take(code) is not None
    assert store.take(code) is None  # second time gone


def test_take_unknown_code_is_none():
    assert HandoffStore().take("nope") is None


def test_take_after_ttl_is_none():
    ticks = [1000.0]
    store = HandoffStore(ttl_seconds=120, clock=lambda: ticks[0])
    code = store.put("r1", "a1", "alice")
    ticks[0] = 1000.0 + 121  # past TTL
    assert store.take(code) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_desktop_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.desktop_auth_store'`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/cloud/app/desktop_auth_store.py
"""In-process, single-use, short-TTL store for desktop browser-auth handoff.

The browser deposits a Supabase session here (keyed by an opaque code) and the
desktop redeems it exactly once. Single-instance only — same posture as
presence/rate-limit (ADR 0011). Not persisted; a restart drops pending codes,
which is fine (the user just re-initiates login).
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class HandoffSession:
    refresh_token: str
    access_token: str
    user_id: str


class HandoffStore:
    def __init__(self, ttl_seconds: int = 120, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._items: dict[str, tuple[float, HandoffSession]] = {}

    def put(self, refresh_token: str, access_token: str, user_id: str) -> str:
        code = secrets.token_urlsafe(32)
        expires_at = self._clock() + self._ttl
        self._items[code] = (expires_at, HandoffSession(refresh_token, access_token, user_id))
        return code

    def take(self, code: str) -> HandoffSession | None:
        entry = self._items.pop(code, None)  # single-use: remove on read
        if entry is None:
            return None
        expires_at, session = entry
        if self._clock() > expires_at:
            return None
        return session
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && pytest tests/test_desktop_auth.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/desktop_auth_store.py apps/cloud/tests/test_desktop_auth.py
git commit -m "feat(cloud): single-use TTL store for desktop auth handoff"
```

---

### Task 2: Cloud — handoff + redeem endpoints

**Files:**
- Create: `apps/cloud/app/api/desktop_auth.py`
- Modify: `apps/cloud/app/main.py` (import + `include_router`)
- Test: `apps/cloud/tests/test_desktop_auth.py` (append endpoint tests)

**Interfaces:**
- Consumes: `HandoffStore` from Task 1; `get_current_user` from `app.dependencies`.
- Produces: `POST /desktop-auth/handoff` (auth required) body `{refresh_token: str, access_token: str}` → `{code: str}`. `POST /desktop-auth/redeem` (no auth) body `{code: str}` → `{access_token, refresh_token, user_id}` or 404. Store lives on `app.state.handoff_store`.

- [ ] **Step 1: Write the failing test (append to test_desktop_auth.py)**

```python
from fastapi.testclient import TestClient

from app.main import create_app


def _client() -> TestClient:
    app = create_app()
    return TestClient(app)


def test_handoff_then_redeem_roundtrip():
    with _client() as c:
        h = c.post(
            "/desktop-auth/handoff",
            json={"refresh_token": "r1", "access_token": "a1"},
            headers={"X-User-Id": "alice"},
        )
        assert h.status_code == 200, h.text
        code = h.json()["code"]

        r = c.post("/desktop-auth/redeem", json={"code": code})
        assert r.status_code == 200, r.text
        assert r.json() == {"access_token": "a1", "refresh_token": "r1", "user_id": "alice"}


def test_redeem_is_single_use():
    with _client() as c:
        code = c.post(
            "/desktop-auth/handoff",
            json={"refresh_token": "r1", "access_token": "a1"},
            headers={"X-User-Id": "alice"},
        ).json()["code"]
        assert c.post("/desktop-auth/redeem", json={"code": code}).status_code == 200
        assert c.post("/desktop-auth/redeem", json={"code": code}).status_code == 404


def test_redeem_unknown_code_404():
    with _client() as c:
        assert c.post("/desktop-auth/redeem", json={"code": "nope"}).status_code == 404


def test_handoff_requires_auth_in_supabase_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "x")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        with _client() as c:
            resp = c.post(
                "/desktop-auth/handoff",
                json={"refresh_token": "r1", "access_token": "a1"},
            )  # no bearer
            assert resp.status_code == 401
    finally:
        get_settings.cache_clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && pytest tests/test_desktop_auth.py -v`
Expected: FAIL — 404 on `/desktop-auth/handoff` (route not registered)

- [ ] **Step 3: Create the router**

```python
# apps/cloud/app/api/desktop_auth.py
"""Desktop browser-auth handoff (ADR 0014).

The web app, after a Supabase sign-in, deposits its session here; the desktop
redeems the returned opaque code exactly once. `/handoff` is authenticated (the
depositor is a signed-in user); `/redeem` is NOT — the single-use, short-TTL
code IS the credential, and requiring a token there would defeat the purpose.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.dependencies import User, get_current_user

router = APIRouter(prefix="/desktop-auth", tags=["desktop-auth"])


class HandoffRequest(BaseModel):
    refresh_token: str
    access_token: str


class HandoffResponse(BaseModel):
    code: str


class RedeemRequest(BaseModel):
    code: str


class RedeemResponse(BaseModel):
    access_token: str
    refresh_token: str
    user_id: str


@router.post("/handoff", response_model=HandoffResponse)
def handoff(
    body: HandoffRequest,
    request: Request,
    user: User = Depends(get_current_user),
) -> HandoffResponse:
    store = request.app.state.handoff_store
    code = store.put(
        refresh_token=body.refresh_token,
        access_token=body.access_token,
        user_id=user.id,
    )
    return HandoffResponse(code=code)


@router.post("/redeem", response_model=RedeemResponse)
def redeem(body: RedeemRequest, request: Request) -> RedeemResponse:
    session = request.app.state.handoff_store.take(body.code)
    if session is None:
        raise HTTPException(status_code=404, detail="invalid_or_expired_code")
    return RedeemResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user_id=session.user_id,
    )
```

- [ ] **Step 4: Wire the store + router in main.py**

In `apps/cloud/app/main.py`, add to the import line for routers:

```python
from app.api import (
    assistant, desktop_auth, discussions, github, health, integrations, presence, sync, workspaces,
)
```

In `lifespan`, alongside the other `app.state.*` setup (e.g. after `app.state.presence = ...`):

```python
    from app.desktop_auth_store import HandoffStore

    app.state.handoff_store = HandoffStore()
```

In `create_app`, register the router next to the others:

```python
    app.include_router(desktop_auth.router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/cloud && pytest tests/test_desktop_auth.py -v && ruff check .`
Expected: PASS (all), ruff clean

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/api/desktop_auth.py apps/cloud/app/main.py apps/cloud/tests/test_desktop_auth.py
git commit -m "feat(cloud): desktop-auth handoff and redeem endpoints"
```

---

### Task 3: Engine — browser-login start + redeem routes

**Files:**
- Modify: `apps/engine/src/config.ts` (add `CLOUD_WEB_URL`)
- Modify: `apps/engine/src/cloudClient.ts` (add `redeemDesktopCode`)
- Modify: `apps/engine/src/routes/cloud.ts` (new routes; drop supabase password branch)

**Interfaces:**
- Consumes: cloud `POST /desktop-auth/redeem` from Task 2; `storeCloudSession` from `cloudClient.ts`.
- Produces: `POST /engine/cloud/login/browser` → `{ url: string, state: string }`. `POST /engine/cloud/login/redeem` body `{ code: string, state: string }` → `{ connected: true, mode: "supabase", userId: string }` or error. `redeemDesktopCode(code: string): Promise<{ accessToken, refreshToken, userId }>`.

- [ ] **Step 1: Add `CLOUD_WEB_URL` to config.ts**

Append to `apps/engine/src/config.ts`:

```typescript
// Where the browser is sent for interactive sign-in (ADR 0014). Defaults to
// the hosted web app; override for local dev against `pnpm web`
// (http://localhost:3000). Not nullable — browser login needs a destination.
export const CLOUD_WEB_URL = process.env.CLOUD_WEB_URL || "https://app.promptconnext.com";
```

> Note: confirm the production web origin before shipping; `https://app.promptconnext.com` is a placeholder pending the rebrand's DNS. For local testing set `CLOUD_WEB_URL=http://localhost:3000`.

- [ ] **Step 2: Add `redeemDesktopCode` to cloudClient.ts**

Append to `apps/engine/src/cloudClient.ts` (uses a raw `fetch`, not `cloudFetch`, because there is no session yet):

```typescript
// Exchange a one-time handoff code (from the promptconnext:// callback) for the
// Supabase session, via apps/cloud's unauthenticated redeem endpoint (ADR 0014).
export async function redeemDesktopCode(
  code: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  if (!CLOUD_API_URL) throw new CloudNotConfiguredError();
  const res = await fetch(`${CLOUD_API_URL}/desktop-auth/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { detail?: string }).detail ?? `redeem failed (HTTP ${res.status})`);
  }
  const ok = data as { access_token: string; refresh_token: string; user_id: string };
  return { accessToken: ok.access_token, refreshToken: ok.refresh_token, userId: ok.user_id };
}
```

- [ ] **Step 3: Replace the supabase login path in routes/cloud.ts**

In `apps/engine/src/routes/cloud.ts`, update the imports:

```typescript
import { CLOUD_API_URL, CLOUD_WEB_URL } from "../config.ts";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cloudFetch,
  cloudMode,
  clearCloudSession,
  loadCloudSession,
  redeemDesktopCode,
  storeCloudSession,
} from "../cloudClient.ts";
```

(Remove `supabasePasswordLogin` from the import list.)

Replace the `if (cloudMode() === "supabase") { … }` block inside `POST /engine/cloud/login` so that route handles **stub only**:

```typescript
cloud.post("/engine/cloud/login", async (c) => {
  if (!CLOUD_API_URL) return c.json({ error: "cloud sync is not configured" }, 409);
  if (cloudMode() === "supabase") {
    return c.json(
      { error: "supabase login is browser-based; call /engine/cloud/login/browser" },
      400,
    );
  }
  const body = await c.req.json<{ userId?: string }>();
  if (!body.userId?.trim()) {
    return c.json({ error: "userId is required (cloud is running in stub auth mode)" }, 400);
  }
  const userId = body.userId.trim();
  storeCloudSession({ mode: "stub", userId });
  return c.json({ connected: true, mode: "stub", userId });
});

// One pending browser login per install (desktop is single-user, ADR 0010).
let pendingLoginState: string | null = null;

cloud.post("/engine/cloud/login/browser", (c) => {
  if (!CLOUD_API_URL) return c.json({ error: "cloud sync is not configured" }, 409);
  if (cloudMode() !== "supabase") {
    return c.json({ error: "browser login is only used in supabase auth mode" }, 400);
  }
  const state = randomBytes(16).toString("hex");
  pendingLoginState = state;
  const url = `${CLOUD_WEB_URL}/login?desktop=1&state=${state}`;
  return c.json({ url, state });
});

cloud.post("/engine/cloud/login/redeem", async (c) => {
  const body = await c.req.json<{ code?: string; state?: string }>();
  if (!body.code?.trim() || !body.state?.trim()) {
    return c.json({ error: "code and state are required" }, 400);
  }
  if (!pendingLoginState || body.state !== pendingLoginState) {
    return c.json({ error: "unexpected or expired login state" }, 400);
  }
  pendingLoginState = null; // consume regardless of outcome
  try {
    const { accessToken, userId } = await redeemDesktopCode(body.code.trim());
    storeCloudSession({ mode: "supabase", userId }, accessToken);
    return c.json({ connected: true, mode: "supabase", userId });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
});
```

> The refresh token from redeem is intentionally not persisted here — parity with the old password login, which stored only the access token. Refresh-on-401 is out of scope (spec §Out of scope); track as a follow-up.

- [ ] **Step 4: Typecheck the engine**

Run: `cd apps/engine && npx tsc --noEmit`
Expected: no errors. (If `supabasePasswordLogin` is now unused in `cloudClient.ts`, leave the export — it's public API; or delete it and its callers. Verify nothing else imports it: `grep -rn supabasePasswordLogin apps/engine/src`.)

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/config.ts apps/engine/src/cloudClient.ts apps/engine/src/routes/cloud.ts
git commit -m "feat(engine): browser-login start + redeem routes for desktop auth"
```

---

### Task 4: Web — desktop handoff passthrough

**Files:**
- Modify: `apps/web/src/lib/auth.tsx` (expose session tokens)
- Modify: `apps/web/src/app/(auth)/login/page.tsx` (desktop handoff effect + carry query on links)
- Modify: `apps/web/src/app/(auth)/register/page.tsx` (carry `desktop`/`state` query on the sign-in link)

**Interfaces:**
- Consumes: cloud `POST /desktop-auth/handoff` from Task 2; `apiFetch` from `lib/api.ts`.
- Produces: `getSessionTokens(): Promise<{ accessToken: string; refreshToken: string } | null>` on the auth context. Login page redirects to `promptconnext://auth/callback?code=…&state=…` after a desktop-flagged sign-in.

- [ ] **Step 1: Expose session tokens from auth.tsx**

In `apps/web/src/lib/auth.tsx`, add to `AuthContextValue`:

```typescript
  getSessionTokens: () => Promise<{ accessToken: string; refreshToken: string } | null>;
```

Add the implementation in `AuthProvider` (near the other `useCallback`s):

```typescript
  const getSessionTokens = useCallback(async () => {
    const { data } = await getSupabase().auth.getSession();
    const session = data.session;
    if (!session) return null;
    return { accessToken: session.access_token, refreshToken: session.refresh_token };
  }, []);
```

Add `getSessionTokens` to both the `value` object and its dependency array in the `useMemo`.

- [ ] **Step 2: Add the desktop handoff to the login page**

In `apps/web/src/app/(auth)/login/page.tsx`, extend `LoginForm`. Read the desktop flag and wire an effect that fires once a session exists:

```typescript
import { apiFetch } from "@/lib/api";
// ...
function LoginForm() {
  const { user, signInStub, signInSupabase, getSessionTokens } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const desktop = params.get("desktop") === "1";
  const desktopState = params.get("state");
  // ...existing state...

  useEffect(() => {
    if (!user) return;
    if (desktop && desktopState) {
      // Hand the session to the cloud broker, then bounce to the desktop.
      (async () => {
        const tokens = await getSessionTokens();
        if (!tokens) return;
        try {
          const { code } = await apiFetch<{ code: string }>(
            "/desktop-auth/handoff",
            { authorization: `Bearer ${tokens.accessToken}` },
            {
              method: "POST",
              body: JSON.stringify({
                refresh_token: tokens.refreshToken,
                access_token: tokens.accessToken,
              }),
            },
          );
          window.location.href =
            `promptconnext://auth/callback?code=${encodeURIComponent(code)}` +
            `&state=${encodeURIComponent(desktopState)}`;
        } catch {
          // fall through to normal redirect on failure
          router.replace(next);
        }
      })();
      return;
    }
    router.replace(next);
  }, [user, desktop, desktopState, getSessionTokens, next, router]);
```

Keep `if (user) return null;` after the effect (the page renders nothing once signed in — the effect handles both desktop and web redirects).

- [ ] **Step 3: Carry the desktop query through the auth cross-links**

Still in the login page, compute the current query suffix and append it to the register + forgot links so a user who detours to register/forgot stays in the desktop flow:

```typescript
  const qs = params.toString();
  const withQuery = (path: string) => (qs ? `${path}?${qs}` : path);
```

Update the `AuthLinks`:

```tsx
      <AuthLinks>
        <span>
          No account? <AuthLink href={withQuery("/register")}>Create one</AuthLink>
        </span>
        <span>
          <AuthLink href={withQuery("/forgot-password")}>Forgot your password?</AuthLink>
        </span>
      </AuthLinks>
```

In `apps/web/src/app/(auth)/register/page.tsx`, do the same for its "Sign in" link. Add near the top of the component:

```typescript
import { useSearchParams } from "next/navigation";
// ...
  const params = useSearchParams();
  const qs = params.toString();
  const loginHref = qs ? `/login?${qs}` : "/login";
```

and change the register cross-link to `<AuthLink href={loginHref}>Sign in</AuthLink>`. (Register itself already redirects to login after "check your email"; the query on the link keeps the desktop flow alive when the user backs out to sign in instead.)

> `register` is wrapped by `useStubRedirect` already; it uses `useSearchParams`, so it must stay a client component (it is). No `Suspense` change needed — the `(auth)` pages are all client-rendered.

- [ ] **Step 4: Typecheck + build the web app**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: no type errors; build succeeds; `/login`, `/register`, `/forgot-password`, `/reset-password` all present.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/auth.tsx apps/web/src/app/\(auth\)/login/page.tsx apps/web/src/app/\(auth\)/register/page.tsx
git commit -m "feat(web): hand desktop sign-in session to cloud broker + promptconnext:// redirect"
```

---

### Task 5: Desktop — deep-link plugin, scheme registration, Rust handler

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `tauri-plugin-deep-link`, `tauri-plugin-single-instance`)
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (register `promptconnext` scheme)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (init plugin, forward callback URL to webview)

**Interfaces:**
- Produces: a Tauri event `auth-callback` emitted to the `main` window with payload `{ url: string }` whenever the OS opens a `promptconnext://` URL.

> **Verify against docs during implementation:** `tauri-plugin-deep-link` v2 API (`on_open_url`, `register`/`register_all`) and the single-instance requirement on Windows/Linux. Pin the same major as `tauri = "2"`. The steps below reflect the v2 plugin shape; adjust to the installed version's exact signatures.

- [ ] **Step 1: Add the plugin dependencies**

In `apps/desktop/src-tauri/Cargo.toml` under `[dependencies]`:

```toml
tauri-plugin-deep-link = "2"
tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }
```

- [ ] **Step 2: Register the scheme in tauri.conf.json**

Add a `plugins` block to `apps/desktop/src-tauri/tauri.conf.json` (sibling of `app` / `bundle`):

```json
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["promptconnext"]
      }
    }
  }
```

- [ ] **Step 3: Init the plugin and forward the callback URL**

In `apps/desktop/src-tauri/src/lib.rs`, add the plugin. First the single-instance plugin must be registered **first** (Tauri requirement), then deep-link. Update the builder in `run()`:

```rust
use tauri::Emitter; // for app.emit / window.emit

// ...inside run(), before .setup(...):
tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // Focus the existing window when a second launch (e.g. from the OS
        // opening a promptconnext:// URL) hits an already-running instance.
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
    }))
    .plugin(tauri_plugin_deep_link::init())
    .setup(move |app| {
        // ...existing engine spawn + window build...

        // Forward every promptconnext:// callback to the webview, which parses
        // ?code & ?state and calls the engine redeem route. Only an opaque
        // one-time code rides this URL (ADR 0014).
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                let _ = handle.emit("auth-callback", url.to_string());
            }
        });
        Ok(())
    })
    // ...rest unchanged...
```

> On Linux/dev, runtime registration may be needed: `app.deep_link().register("promptconnext")?;` guarded by `#[cfg(target_os = "linux")]`. macOS/Windows use the bundle/registry registration from Step 2 at install time. Confirm per the plugin docs.

- [ ] **Step 4: Verify the Rust builds**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compiles. (First build pulls the two plugins.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): register promptconnext:// deep link, forward callback to webview"
```

---

### Task 6: Desktop — browser-login UI + redeem wiring

**Files:**
- Modify: `apps/desktop/src/api.ts` (bindings for the new engine routes)
- Modify: `apps/desktop/src/components/CloudConnect.tsx` (replace email/password with "Sign in with browser")

**Interfaces:**
- Consumes: engine `POST /engine/cloud/login/browser` and `/engine/cloud/login/redeem` from Task 3; the `auth-callback` Tauri event from Task 5; `@tauri-apps/plugin-opener` `openUrl`.
- Produces: signed-in `CloudSession` after the round trip; UI shows a "waiting for browser…" state meanwhile.

- [ ] **Step 1: Add api.ts bindings**

In `apps/desktop/src/api.ts`, near the other cloud bindings, add:

```typescript
export const startBrowserLogin = () =>
  request<{ url: string; state: string }>("/engine/cloud/login/browser", { method: "POST" });

export const redeemBrowserLogin = (code: string, state: string) =>
  request<CloudSession>("/engine/cloud/login/redeem", {
    method: "POST",
    body: JSON.stringify({ code, state }),
  });
```

Update the existing `cloudLogin` type to stub-only (supabase now goes through the browser flow):

```typescript
export const cloudLogin = (payload: { userId: string }) =>
  request<CloudSession>("/engine/cloud/login", { method: "POST", body: JSON.stringify(payload) });
```

- [ ] **Step 2: Ensure the opener plugin is available**

Confirm `@tauri-apps/plugin-opener` is a dependency of `apps/desktop` (Tauri 2 default). If missing: `pnpm --dir apps/desktop add @tauri-apps/plugin-opener` and add `tauri-plugin-opener = "2"` to `src-tauri/Cargo.toml`, plus `.plugin(tauri_plugin_opener::init())` in `lib.rs`.

- [ ] **Step 3: Replace the supabase form in CloudConnect.tsx**

In `apps/desktop/src/components/CloudConnect.tsx`:

Update imports — drop `email`/`password` state, add:

```typescript
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/event";
import { startBrowserLogin, redeemBrowserLogin } from "../api";
```

Replace the `config.mode === "supabase"` branch of the not-connected view with a single button + waiting state. Add a `waiting` flag and an effect that listens for the callback:

```tsx
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const unlisten = listen<string>("auth-callback", async (event) => {
      try {
        const url = new URL(event.payload);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return;
        await redeemBrowserLogin(code, state);
        setWaiting(false);
        await refresh();
      } catch (err) {
        setWaiting(false);
        setError((err as Error).message);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginBrowserLogin = async () => {
    setError(null);
    setWaiting(true);
    try {
      const { url } = await startBrowserLogin();
      await openUrl(url);
    } catch (err) {
      setWaiting(false);
      setError((err as Error).message);
    }
  };
```

And the supabase branch JSX becomes:

```tsx
        {config.mode === "supabase" ? (
          <>
            <p className="muted">Sign in through your browser to connect this app to PromptConnext Cloud.</p>
            <button type="button" disabled={waiting} onClick={beginBrowserLogin}>
              {waiting ? "Waiting for browser…" : "Sign in with browser"}
            </button>
          </>
        ) : (
```

Leave the stub branch (`User id` input) unchanged.

- [ ] **Step 4: Typecheck the desktop webview**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: no errors. (Confirm `@tauri-apps/event` import path matches the installed API — it may be `@tauri-apps/api/event`; adjust.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/components/CloudConnect.tsx
git commit -m "feat(desktop): browser sign-in button + deep-link redeem wiring"
```

---

### Task 7: End-to-end verification

**Files:** none (manual verification + doc note).

- [ ] **Step 1: Cloud unit suite green**

Run: `cd apps/cloud && pytest -q && ruff check .`
Expected: all pass, ruff clean.

- [ ] **Step 2: Engine + web + desktop typecheck**

Run:
```bash
cd apps/engine && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
cd apps/desktop && npx tsc --noEmit
```
Expected: all clean.

- [ ] **Step 3: Manual happy path (requires real Supabase + registered scheme)**

With `CLOUD_WEB_URL=http://localhost:3000`, a local `pnpm web`, `pnpm engine` (supabase mode env set), and a dev build of the desktop app:
1. Open a project → CloudConnect → "Sign in with browser".
2. Browser opens `localhost:3000/login?desktop=1&state=…`; sign in.
3. Browser redirects to `promptconnext://auth/callback?code=…`; the desktop refocuses and shows the signed-in workspace list.

Document the outcome (or, if the scheme can't be registered in the sandbox, note that the manual step is deferred and the automated layers all pass).

- [ ] **Step 4: Commit any doc note**

```bash
git add docs/
git commit -m "docs: record desktop browser-auth verification status"
```

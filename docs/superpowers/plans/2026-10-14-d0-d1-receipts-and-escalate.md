# D0 + D1 core: approval layer to CEO v2.1, receipts and Escalate hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PromptWorkspace's decision layer match View 1 of the CEO's Enterprise AI Architecture v2.1: the lane matrix and vocabulary are recorded in plan 0029 (D0), and every decision transition leaves a tamper-evident, verifiable receipt, with personal data erasable, no self-approval, decision timeouts, and email to the people who must decide (D1 core).

**Architecture:** A per-project, append-only, SHA-256 hash-chained `pw_receipts` table is written after every decision and hat change. Receipts are *derived* from decision rows (`expected_events`), so a receipt write that fails is repaired by the next write in the same project instead of being lost. Decision document snapshots move from `pw_decisions.subject_content` into an erasable `pw_decision_snapshots` table; the chain only ever holds the document hash. Separation of duties, expiry and the reminder sweep are rules in `app/delivery/decisions.py` and a background loop; email goes through a small SMTP mailer using the same Brevo account Supabase Auth already uses.

**Tech Stack:** FastAPI + Pydantic v2, supabase-py (PostgREST), Postgres migrations via `apps/cloud/scripts/migrate.py`, pytest (in-memory + contract suite against both adapters), Next.js 16 / React 19 web with vitest.

**Spec:** umbrella repo `docs/plans/2026-10-11-enterprise-ai-architecture-v2-1-plan.md` (§1.3 lane matrix, §2.1 vocabulary mapping, §3 status legend, §4 D0 and D1 rows, §6 risks) and the CEO's View 1 / View 2 PDFs (umbrella `local/`, not committed). PromptWorkspace `docs/plans/0029-agent-native-delivery.md` is the engineering source of truth that Task 1 amends.

**Decisions taken on 2026-10-14 (user):**
- Build PromptWorkspace to the CEO's latest diagram (v2.1 View 1): decision 1 of the v2.1 plan is accepted, View 1's lane matrix replaces plan 0029 §5.4.
- No self-approval is **strict**: a requester can never resolve their own decision, even in a one-person workspace. The cloud must email the people who have to decide.
- Scope of this plan: D0 + D1 core. Deferred to a D1b plan: four-eyes for T3, step-up MFA (AAL2) for T3, delegation records. They need T3 decisions, which arrive with the risk-tiered gate in D3.

## Branching

- Task 1 commits to `feature/trust-outcome` (it is D0 material and rides release PR #17).
- Tasks 2–11 run on `feature/d1-receipts`, branched from `feature/trust-outcome` after Task 1. Its PR targets `develop` and is opened only after PR #17 merges (then `git rebase origin/develop` is a no-op apart from the merge commit).
- Never bump the umbrella submodule pointer from this work (umbrella `AGENTS.md` rule 0).

## Global Constraints

- Python: run everything from `apps/cloud` with its venv: `.venv/bin/pytest -q` (offline, in-memory, `AUTH_MODE=stub`). Contract cases: `.venv/bin/pytest -q -m contract` (Supabase parameter skips unless `PROMPTWORKSPACE_CONTRACT_SUPABASE_URL`/`_KEY` are set; see `tests/contract/conftest.py`).
- Web: from `apps/web`: `pnpm test` and `pnpm typecheck`.
- Every new table is service-only from birth: `enable row level security`, `revoke all … from authenticated, anon`, explicit grants to `service_role`, and the table name added to `_SERVICE_ONLY_TABLES` in `app/db/supabase_repository.py`.
- Migrations are numbered `0007`, `0008`, `0009` in `apps/cloud/migrations/`, each with the header style of `0004`/`0006` (THE PROBLEM / SHAPE / GRANTS / DEPLOY ORDER). Never edit an applied migration (`migrate.py status` flags edits).
- No personal data in receipts or emails: receipts carry ids, hashes, kinds and statuses; free text (rationale, erasure reason) is stored only as its SHA-256. Emails carry the decision title, project name and a link, never document content.
- Receipt hashing: SHA-256 over canonical JSON (`sort_keys=True, separators=(",", ":"), ensure_ascii=False`), timestamps as UTC ISO-8601 with microseconds, genesis `prev_hash` = 64 zeros. Receipt `body` values are `str | int | bool | None` only (no floats; jsonb round-trips them unchanged).
- A receipt or email failure never fails the decision request that caused it: log with `logger.exception` and continue. The single exception is the erase endpoint (Task 7), which answers 503 `receipt_write_failed` and is safe to retry.
- Error codes are snake_case `detail` strings, as in `app/api/delivery.py`.
- Commits: scoped Conventional Commits (`feat(cloud): …`, `feat(web): …`, `docs(plans): …`). Do not push until Task 11.
- Dates in docs are absolute.

## Review Focus

1. **Concurrent writes to one project's chain** (two approvals in the same second): both must end up with receipts, contiguous `seq`, no duplicate decision events. Pinned in Task 3 (contract: seq conflict raises `ReceiptConflict`) and Task 4 (sync retries after a conflict).
2. **Timestamp round-trip through Postgres** changes the string a hash was computed over (`Z` vs `+00:00`, dropped microseconds), making every receipt "tampered" on the Supabase adapter only. Pinned in Task 3 (contract test verifies a chain read back from the store).
3. **A one-person workspace** (the trust environment today): a request must still be created, must say nobody else can approve it (`blocked == "no_approver"`), must send no email, and the web must tell the user to assign the hat to another member. Pinned in Task 6 and Task 10.
4. **Old open decisions when migration 0009 lands**: they must not expire on the first sweep. 0009 gives them `now() + 7 days`. Pinned in Task 9 (sweep test with a decision whose `expires_at` is in the future does nothing).
5. **Erasing a snapshot** must not change any receipt, the decision's hash, or its approval state, and the web must keep rendering the decision without content. Pinned in Task 7 (chain verifies after erase; approval state unchanged).

---

### Task 1: D0 — amend plan 0029 to v2.1 (lane matrix, vocabulary, status legend)

**Files:**
- Modify: `docs/plans/0029-agent-native-delivery.md` (§5.4 at line ~610, new §2.4 after §2.3, §13 table at line ~838)
- Modify (umbrella repo, separate commit on umbrella `main`): `../docs/plans/2026-10-11-enterprise-ai-architecture-v2-1-plan.md` §5

**Interfaces:**
- Consumes: nothing.
- Produces: the lane matrix and vocabulary every later milestone (D2, D3) builds against.

- [ ] **Step 1: Confirm the branch**

Run: `git -C /Users/kittisak/REPO/ideva/promptconnext-projects/PromptWorkspace status --short --branch`
Expected: `## feature/trust-outcome...origin/feature/trust-outcome` with only `?? .superpowers/` untracked.

- [ ] **Step 2: Replace §5.4 with the View 1 matrix**

Replace the whole `### 5.4 Autonomy levels (per project)` section body (table and the paragraph after it) with:

```markdown
### 5.4 Autonomy levels and the lane matrix (per project)

Amended 2026-10-14 to the CEO's Enterprise AI Architecture v2.1, View 1 (umbrella `docs/plans/2026-10-11-enterprise-ai-architecture-v2-1-plan.md` §1.3, decision 1). The earlier text let L1 auto-merge T1; View 1 is stricter and is now the rule.

| Level | Name | Who it is for |
|---|---|---|
| **A0** | Observe | Agents read and propose; no actions at all |
| **L0** | Assisted | First project, sceptical teams, migration Phase 1 |
| **L1** | Supervised (default) | Most teams |
| **L2** | Autonomous | Projects that earned it through the promotion rule |

| | T0 routine | T1 standard | T2 elevated | T3 critical |
|---|---|---|---|---|
| **L2** | Pass | Pass* | Escalate to steward | Escalate to steward + named approver |
| **L1** | Pass | Escalate | Escalate to steward | Escalate to steward + named approver |
| **L0** | Escalate | Escalate | Escalate to steward | Escalate to steward + named approver |
| **A0** | no actions | no actions | no actions | no actions |

\* Only with strong evidence and within budget; otherwise Escalate.

Rules that hold at every level, in this order, before the matrix is read:

1. Any policy violation → **Keep out**.
2. Over budget → **Escalate**.
3. The tier is the maximum of the action's floor (merge ≥ T1, release ≥ T2, production data = T3) and the Change's predicted tier. A merge touching auth, money or personal data is T3.

Promotion (L1 → L2) is itself a Decision with a receipt; an incident demotes. The level is a guardrail decision shown on Mission Control.
```

- [ ] **Step 3: Add §2.4, the v2.1 vocabulary mapping**

Insert after the end of §2.3 (before `## 3. As-Is vs. To-Be`):

```markdown
### 2.4 v2.1 vocabulary (customer-facing names)

Added 2026-10-14. The CEO's v2.1 View 2 names the workflow stages differently. Customer-facing material uses the v2.1 names; engineering keeps this plan's names.

| v2.1 (customer-facing) | This plan (engineering) |
|---|---|
| 1 Inception: Project Constitution, Spec, agents draft, Commander + product owner approve | ① Intent and ② Plan |
| 2 Construction: spec items → tasks → agent team, sandbox, hash-anchored edits | ③ Execute |
| 3 Validation: four checks, independent reviewer, Commander signs where the tier requires | ④ Verify |
| 4 Operation: staged release, release needs a person at T2, incident rule | ⑤ Release |
| Pass / Escalate / Keep out | gate lanes (unchanged) |
| Handoff (to a human agent) | **Take over** |
| AI Commander L1–L3 | a person's certification level; caps the project's autonomy level (D3) |

Status tags for anything shown outside the company follow the v2.1 plan §3: **Production** (on `main`), **Trust env** (on the trust environment, not merged), **Designed**, **Proposed**.
```

- [ ] **Step 4: Add the follow-up rows to §13**

Append these rows to the §13 table (numbers continue from the last row, 17):

```markdown
| 18 | D1b: four-eyes for T3 decisions, step-up MFA (AAL2) for T3 approvals, delegation records | Enterprise AI v2.1 plan §4 D1 | With D3, when T3 decisions exist |
| 19 | Drop `pw_decisions.subject_content` once every environment has run migration 0008 and the fallback read is removed | D1 core (2026-10-14 plan) | Any later migration |
| 20 | v2.1 delivery milestones D2–D6 (agents act, gate on every change, platform extraction, second product, Commanders) | Umbrella `docs/plans/2026-10-11-enterprise-ai-architecture-v2-1-plan.md` §4 | One plan per milestone, after D1 |
```

- [ ] **Step 5: Check the rendering and commit**

Run: `grep -n "### 2.4\|### 5.4\|^| 18 \|^| 20 " docs/plans/0029-agent-native-delivery.md`
Expected: four matches.

```bash
git add docs/plans/0029-agent-native-delivery.md docs/superpowers/plans/2026-10-14-d0-d1-receipts-and-escalate.md
git commit -m "docs(plans): amend plan 0029 to enterprise AI v2.1 (View 1 lane matrix, vocabulary, status tags); D0+D1 plan"
```

- [ ] **Step 6: Record decision 1 in the umbrella plan (umbrella repo, `main`)** — CONTROLLER ONLY (ledger ruling R3): the implementer skips this step.

In umbrella `docs/plans/2026-10-11-enterprise-ai-architecture-v2-1-plan.md` §5, append to item 1: ` **Accepted 2026-10-14.** Plan 0029 §5.4 amended the same day.` Commit in the umbrella repo with only that file (leave `PromptWorkspace` and `HANDOFF.md` unstaged):

```bash
git -C /Users/kittisak/REPO/ideva/promptconnext-projects add docs/plans/2026-10-11-enterprise-ai-architecture-v2-1-plan.md
git -C /Users/kittisak/REPO/ideva/promptconnext-projects commit -m "docs(plans): v2.1 decision 1 accepted (View 1 lane matrix)"
```

- [ ] **Step 7: Branch for D1**

```bash
git switch -c feature/d1-receipts
```

---

### Task 2: Receipt model, sealing and chain verification (pure)

**Files:**
- Modify: `apps/cloud/app/models/schemas.py` (after `class Decision`, line ~1333)
- Create: `apps/cloud/app/delivery/receipts.py`
- Test: `apps/cloud/tests/test_receipts_chain.py`

**Interfaces:**
- Produces:
  - `ReceiptEvent = Literal["decision.requested", "decision.approved", "decision.rejected", "decision.withdrawn", "decision.expired", "decision.snapshot_erased", "role.assigned", "role.cleared"]`
  - `class ReceiptDraft(BaseModel)`: `project_id: str`, `workspace_id: str`, `event: ReceiptEvent`, `subject_type: Literal["decision", "project_role"]`, `subject_id: str`, `actor: str`, `body: dict[str, str | int | bool | None]`
  - `class Receipt(ReceiptDraft)`: adds `id: str`, `seq: int`, `prev_hash: str`, `hash: str`, `created_at: datetime`
  - `app.delivery.receipts.GENESIS: str`, `stamp(at: datetime) -> str`, `sha256_text(text: str) -> str`, `receipt_hash(r: Receipt) -> str`, `seal(draft: ReceiptDraft, previous: Receipt | None, *, at: datetime | None = None) -> Receipt`, `verify_chain(receipts: list[Receipt]) -> ChainCheck`
  - `@dataclass(frozen=True) class ChainCheck`: `ok: bool`, `count: int`, `head: str | None`, `broken_at: int | None`, `reason: str | None`

- [ ] **Step 1: Write the failing tests**

`apps/cloud/tests/test_receipts_chain.py`:

```python
"""Hash-chained receipts (enterprise AI v2.1 D1): sealing and verification.
Pure functions, so every way a chain can break is pinned."""

from __future__ import annotations

from datetime import datetime, timezone

from app.delivery.receipts import GENESIS, receipt_hash, seal, stamp, verify_chain
from app.models.schemas import ReceiptDraft


def _draft(event="decision.requested", subject_id="d1", **body):
    return ReceiptDraft(
        project_id="p", workspace_id="w", event=event, subject_type="decision",
        subject_id=subject_id, actor="alice", body=body or {"kind": "plan_approval"},
    )


def _chain(n: int):
    out, previous = [], None
    for i in range(n):
        previous = seal(_draft(subject_id=f"d{i}"), previous)
        out.append(previous)
    return out


def test_the_first_receipt_links_to_genesis_and_counts_from_one():
    r = seal(_draft(), None)
    assert r.seq == 1
    assert r.prev_hash == GENESIS == "0" * 64
    assert r.hash == receipt_hash(r) and len(r.hash) == 64


def test_each_receipt_links_to_the_one_before():
    a, b, c = _chain(3)
    assert (b.seq, b.prev_hash) == (2, a.hash)
    assert (c.seq, c.prev_hash) == (3, b.hash)


def test_an_intact_chain_verifies():
    chain = _chain(3)
    check = verify_chain(chain)
    assert check.ok and check.count == 3 and check.head == chain[-1].hash
    assert check.broken_at is None and check.reason is None


def test_an_empty_chain_verifies():
    check = verify_chain([])
    assert check.ok and check.count == 0 and check.head is None


def test_an_edited_body_breaks_the_chain_at_that_receipt():
    chain = _chain(3)
    chain[1] = chain[1].model_copy(update={"body": {"kind": "intent_approval"}})
    check = verify_chain(chain)
    assert not check.ok and check.broken_at == 2 and check.reason == "hash_mismatch"


def test_a_removed_receipt_breaks_the_chain():
    a, _, c = _chain(3)
    check = verify_chain([a, c])
    assert not check.ok and check.broken_at == 2 and check.reason == "seq_gap"


def test_a_rehashed_forgery_still_breaks_the_link():
    chain = _chain(3)
    forged = chain[1].model_copy(update={"actor": "mallory"})
    chain[1] = forged.model_copy(update={"hash": receipt_hash(forged)})
    check = verify_chain(chain)
    assert not check.ok and check.broken_at == 3 and check.reason == "prev_hash_mismatch"


def test_stamp_is_utc_with_microseconds_whatever_the_input_zone():
    bangkok = datetime(2026, 10, 14, 19, 0, 0, tzinfo=timezone.utc).astimezone()
    assert stamp(bangkok) == "2026-10-14T19:00:00.000000+00:00"


def test_the_hash_ignores_dict_key_order():
    r = seal(_draft(a="1", b="2"), None)
    reordered = r.model_copy(update={"body": {"b": "2", "a": "1"}})
    assert receipt_hash(reordered) == r.hash
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_receipts_chain.py`
Expected: FAIL, `ImportError: cannot import name 'ReceiptDraft'`.

- [ ] **Step 3: Add the models**

In `apps/cloud/app/models/schemas.py`, directly after `class Decision`:

```python
ReceiptEvent = Literal[
    "decision.requested",
    "decision.approved",
    "decision.rejected",
    "decision.withdrawn",
    "decision.expired",
    "decision.snapshot_erased",
    "role.assigned",
    "role.cleared",
]


class ReceiptDraft(BaseModel):
    """What a receipt records, before it is sealed into a project's chain
    (enterprise AI v2.1 D1). `body` holds ids, hashes, kinds and statuses
    only: never document text or free text, which may be personal data."""

    project_id: str
    workspace_id: str
    event: ReceiptEvent
    subject_type: Literal["decision", "project_role"]
    subject_id: str
    actor: str
    body: dict[str, str | int | bool | None] = Field(default_factory=dict)


class Receipt(ReceiptDraft):
    """One link of a project's append-only hash chain (`pw_receipts`).
    `hash` covers every other field (app/delivery/receipts.py)."""

    id: str = Field(default_factory=new_id)
    seq: int
    prev_hash: str
    hash: str = ""
    created_at: datetime = Field(default_factory=utcnow)
```

- [ ] **Step 4: Write `app/delivery/receipts.py`**

```python
"""Hash-chained receipts (enterprise AI v2.1 D1, View 1 "Receipts").

Each project has one append-only chain. A receipt's hash is SHA-256 over the
canonical JSON of every other field, including the previous receipt's hash,
so editing, removing or reordering any receipt is detectable from the chain
alone. Pure functions; the store and the recording rules live elsewhere
(app/db, app/delivery/ledger.py).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone

from app.models.schemas import Receipt, ReceiptDraft, utcnow

GENESIS = "0" * 64


def stamp(at: datetime) -> str:
    """The one timestamp form a hash covers: UTC, microseconds, `+00:00`.
    Postgres timestamptz keeps microseconds, so a receipt read back from the
    store stamps to the same string it was sealed with."""
    return at.astimezone(timezone.utc).isoformat(timespec="microseconds")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def receipt_hash(r: Receipt) -> str:
    payload = {
        "id": r.id,
        "project_id": r.project_id,
        "workspace_id": r.workspace_id,
        "seq": r.seq,
        "event": r.event,
        "subject_type": r.subject_type,
        "subject_id": r.subject_id,
        "actor": r.actor,
        "body": r.body,
        "prev_hash": r.prev_hash,
        "created_at": stamp(r.created_at),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_text(canonical)


def seal(draft: ReceiptDraft, previous: Receipt | None, *, at: datetime | None = None) -> Receipt:
    """`draft` as the next link after `previous` (None: the first link)."""
    receipt = Receipt(
        **draft.model_dump(),
        seq=previous.seq + 1 if previous else 1,
        prev_hash=previous.hash if previous else GENESIS,
        created_at=at or utcnow(),
    )
    return receipt.model_copy(update={"hash": receipt_hash(receipt)})


@dataclass(frozen=True)
class ChainCheck:
    ok: bool
    count: int
    head: str | None
    broken_at: int | None = None
    reason: str | None = None


def verify_chain(receipts: list[Receipt]) -> ChainCheck:
    """Check a whole chain, oldest first. `broken_at` is the `seq` position
    (1-based) of the first receipt that does not fit."""
    prev_hash = GENESIS
    for position, r in enumerate(receipts, start=1):
        if r.seq != position:
            return ChainCheck(False, len(receipts), None, position, "seq_gap")
        if r.prev_hash != prev_hash:
            return ChainCheck(False, len(receipts), None, position, "prev_hash_mismatch")
        if receipt_hash(r) != r.hash:
            return ChainCheck(False, len(receipts), None, position, "hash_mismatch")
        prev_hash = r.hash
    return ChainCheck(True, len(receipts), receipts[-1].hash if receipts else None)
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_receipts_chain.py`
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/models/schemas.py apps/cloud/app/delivery/receipts.py apps/cloud/tests/test_receipts_chain.py
git commit -m "feat(cloud): hash-chained receipt model, sealing and verification"
```

---

### Task 3: Receipt store (migration 0007, both adapters, contract tests)

**Files:**
- Create: `apps/cloud/migrations/0007_pw_receipts.sql`
- Modify: `apps/cloud/app/db/repository.py` (exception near line 114; abstract methods after `save_decision` ~line 800; `InMemoryRepository.__init__` ~line 869; in-memory methods after `save_decision` ~line 1902)
- Modify: `apps/cloud/app/db/supabase_repository.py` (constants ~line 120, `_SERVICE_ONLY_TABLES` ~line 166, methods after `save_decision` ~line 1730)
- Test: `apps/cloud/tests/contract/test_receipt_store.py`

**Interfaces:**
- Consumes: `Receipt`, `seal`, `verify_chain` (Task 2).
- Produces:
  - `class ReceiptConflict(RuntimeError)` in `app/db/repository.py`
  - `Repository.list_receipts(project_id: str) -> list[Receipt]` — oldest first; `[]` when the table is missing.
  - `Repository.insert_receipt(receipt: Receipt) -> Receipt` — insert only; raises `ReceiptConflict` when `(project_id, seq)` is taken, or when a `decision` receipt with the same `(subject_id, event)` exists; raises `DeliveryStoreUnavailable` when the table is missing.

- [ ] **Step 1: Write the failing contract tests**

`apps/cloud/tests/contract/test_receipt_store.py`:

```python
"""The receipt store (enterprise AI v2.1 D1), against both adapters."""

from __future__ import annotations

import pytest

from app.db.repository import ReceiptConflict, Repository
from app.delivery.receipts import seal, verify_chain
from app.models.schemas import ReceiptDraft, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def _draft(project, ws, subject_id=None, event="decision.requested", subject_type="decision"):
    return ReceiptDraft(
        project_id=project.id, workspace_id=ws.id, event=event, subject_type=subject_type,
        subject_id=subject_id or new_id(), actor="alice", body={"kind": "plan_approval"},
    )


def test_receipts_round_trip_oldest_first_and_still_verify(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.insert_receipt(seal(_draft(project, ws), None))
    second = repo.insert_receipt(seal(_draft(project, ws), first))

    stored = repo.list_receipts(project.id)

    assert [r.seq for r in stored] == [1, 2]
    assert stored[1].prev_hash == first.hash and stored[1].hash == second.hash
    # Review focus 2: timestamps and jsonb survive the store byte-for-byte.
    assert verify_chain(stored).ok


def test_a_taken_seq_is_a_conflict(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.insert_receipt(seal(_draft(project, ws), None))

    with pytest.raises(ReceiptConflict):
        repo.insert_receipt(seal(_draft(project, ws), None))

    assert [r.id for r in repo.list_receipts(project.id)] == [first.id]


def test_a_decision_event_is_recorded_once(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.insert_receipt(seal(_draft(project, ws, subject_id="d-1"), None))

    with pytest.raises(ReceiptConflict):
        repo.insert_receipt(seal(_draft(project, ws, subject_id="d-1"), first))


def test_role_events_may_repeat(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    subject = f"{project.id}:tech_steward"
    a = repo.insert_receipt(
        seal(_draft(project, ws, subject, "role.assigned", "project_role"), None))
    repo.insert_receipt(seal(_draft(project, ws, subject, "role.assigned", "project_role"), a))

    assert len(repo.list_receipts(project.id)) == 2


def test_chains_are_per_project(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    one, two = h.project(repo, ws, admin), h.project(repo, ws, admin)
    repo.insert_receipt(seal(_draft(one, ws), None))
    repo.insert_receipt(seal(_draft(two, ws), None))

    assert [r.seq for r in repo.list_receipts(one.id)] == [1]
    assert [r.seq for r in repo.list_receipts(two.id)] == [1]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q -m contract tests/contract/test_receipt_store.py`
Expected: FAIL, `ImportError: cannot import name 'ReceiptConflict'`.

- [ ] **Step 3: Write migration 0007**

`apps/cloud/migrations/0007_pw_receipts.sql`:

```sql
-- 0007_pw_receipts — append-only, hash-chained receipts (enterprise AI v2.1 D1).
--
-- THE PROBLEM
-- A decision row is updated in place (open → approved), so nothing shows who
-- did what in which order, and an edited row is indistinguishable from a real
-- one. View 1 of the v2.1 architecture requires tamper-evident receipts.
--
-- SHAPE
-- One chain per project: `seq` counts from 1, `prev_hash` is the previous
-- receipt's `hash` (64 zeros for the first), `hash` is SHA-256 over the
-- canonical JSON of every other column (app/delivery/receipts.py).
-- No foreign key to pw_projects: receipts outlive the project they describe,
-- and a cascade would be refused by the append-only trigger anyway.
-- A decision event is recorded once per decision (partial unique index);
-- role events repeat.
--
-- APPEND-ONLY
-- service_role gets SELECT and INSERT only, and a trigger refuses UPDATE and
-- DELETE for every role, including the table owner.
--
-- DEPLOY ORDER
-- Either order. Reads tolerate a missing table (empty chain); writes are
-- logged and repaired by the next decision write once the table exists.

create table if not exists pw_receipts (
    id uuid primary key,
    project_id uuid not null,
    workspace_id uuid not null,
    seq bigint not null check (seq >= 1),
    event text not null,
    subject_type text not null check (subject_type in ('decision', 'project_role')),
    subject_id text not null,
    actor text not null,
    body jsonb not null default '{}'::jsonb,
    prev_hash text not null check (length(prev_hash) = 64),
    hash text not null check (length(hash) = 64),
    created_at timestamptz not null,
    unique (project_id, seq)
);
create unique index if not exists uq_pw_receipts_decision_event
    on pw_receipts (subject_id, event) where subject_type = 'decision';
create index if not exists idx_pw_receipts_subject on pw_receipts (subject_id);

create or replace function pw_receipts_append_only() returns trigger
language plpgsql as $$
begin
    raise exception 'pw_receipts is append-only';
end;
$$;

drop trigger if exists pw_receipts_no_update on pw_receipts;
create trigger pw_receipts_no_update
    before update or delete on pw_receipts
    for each row execute function pw_receipts_append_only();

alter table pw_receipts enable row level security;
revoke all on pw_receipts from authenticated;
revoke all on pw_receipts from anon;
grant select, insert on pw_receipts to service_role;
```

- [ ] **Step 4: Add the exception and abstract methods**

In `app/db/repository.py`, after `class DeliveryStoreUnavailable`:

```python
class ReceiptConflict(RuntimeError):
    """A receipt insert lost a race: its `seq` is taken in the project's chain,
    or its decision event is already recorded. The caller re-reads the chain
    and seals again (app/delivery/ledger.py)."""
```

Add `Receipt` to the `app.models.schemas` import list. After `save_decision`'s abstract declaration:

```python
    @abc.abstractmethod
    def list_receipts(self, project_id: str) -> list[Receipt]:
        """The project's receipt chain, oldest first. Empty when the table is
        missing (migration 0007 not applied)."""

    @abc.abstractmethod
    def insert_receipt(self, receipt: Receipt) -> Receipt:
        """Insert only. Raises ReceiptConflict when (project_id, seq) is taken
        or a decision receipt with the same (subject_id, event) exists;
        DeliveryStoreUnavailable when the table is missing."""
```

- [ ] **Step 5: In-memory adapter**

In `InMemoryRepository.__init__`, after `self._project_roles`:

```python
        # project_id -> receipt chain, oldest first (enterprise AI v2.1 D1)
        self._receipts: dict[str, list[Receipt]] = {}
```

After the in-memory `save_decision`:

```python
    def list_receipts(self, project_id: str) -> list[Receipt]:
        return [copy.deepcopy(r) for r in self._receipts.get(project_id, [])]

    def insert_receipt(self, receipt: Receipt) -> Receipt:
        chain = self._receipts.setdefault(receipt.project_id, [])
        if any(r.seq == receipt.seq for r in chain):
            raise ReceiptConflict(f"seq {receipt.seq} taken")
        if receipt.subject_type == "decision" and any(
            r.subject_type == "decision"
            and r.subject_id == receipt.subject_id
            and r.event == receipt.event
            for r in chain
        ):
            raise ReceiptConflict(f"{receipt.event} already recorded for {receipt.subject_id}")
        chain.append(copy.deepcopy(receipt))
        chain.sort(key=lambda r: r.seq)
        return copy.deepcopy(receipt)
```

- [ ] **Step 6: Supabase adapter**

In `app/db/supabase_repository.py`: add `_RECEIPTS = "pw_receipts"` after `_PROJECT_ROLES`, add `"pw_receipts"` to `_SERVICE_ONLY_TABLES`, add `_UNIQUE_VIOLATION = "23505"` next to `_MISSING_COLUMN_CODES`, import `Receipt` and `ReceiptConflict`. After `save_decision`:

```python
    def list_receipts(self, project_id: str) -> list[Receipt]:
        try:
            res = (
                self._table(_RECEIPTS)
                .select("*")
                .eq("project_id", project_id)
                .order("seq")
                .execute()
            )
        except Exception as exc:
            if self._missing_table(exc):
                return []
            raise
        return [Receipt(**row) for row in res.data or []]

    def insert_receipt(self, receipt: Receipt) -> Receipt:
        row = _dump(receipt)
        # `created_at` must be stored exactly as hashed (review focus 2).
        row["created_at"] = stamp(receipt.created_at)
        try:
            self._table(_RECEIPTS).insert(row).execute()
        except Exception as exc:
            if self._missing_table(exc):
                raise DeliveryStoreUnavailable() from exc
            if getattr(exc, "code", None) == _UNIQUE_VIOLATION:
                raise ReceiptConflict(str(exc)) from exc
            raise
        return receipt
```

Import `stamp` with `from app.delivery.receipts import stamp`. Note: `.insert`, not `.upsert`: an upsert would overwrite on conflict, which the trigger refuses anyway, but the error would not be a clean 23505.

- [ ] **Step 7: Run the tests**

Run: `cd apps/cloud && .venv/bin/pytest -q -m contract tests/contract/test_receipt_store.py && .venv/bin/pytest -q`
Expected: 5 passed (memory), supabase parameter skipped with its reason; full suite green.

If a local Supabase is available (`tests/contract/conftest.py` docstring), also run with the two `PROMPTWORKSPACE_CONTRACT_SUPABASE_*` variables set after `scripts/migrate.py apply`. Expected: 10 passed. Additionally run in `psql`: `update pw_receipts set actor='x';` Expected: `ERROR: pw_receipts is append-only`.

- [ ] **Step 8: Commit**

```bash
git add apps/cloud/migrations/0007_pw_receipts.sql apps/cloud/app/db/repository.py apps/cloud/app/db/supabase_repository.py apps/cloud/tests/contract/test_receipt_store.py
git commit -m "feat(cloud): append-only receipt store (migration 0007) on both adapters"
```

---

### Task 4: Record a receipt for every decision and hat transition

**Files:**
- Create: `apps/cloud/app/delivery/ledger.py`
- Modify: `apps/cloud/app/api/delivery.py` (`put_project_role` ~line 154, `request_decision` ~line 379, `resolve_decision` ~line 436)
- Test: `apps/cloud/tests/test_receipt_ledger.py`, `apps/cloud/tests/test_decisions_api.py` (append)

**Interfaces:**
- Consumes: `seal`, `stamp`, `sha256_text` (Task 2); `list_receipts`, `insert_receipt`, `ReceiptConflict` (Task 3).
- Produces:
  - `expected_events(decision: Decision) -> list[tuple[datetime, ReceiptDraft]]`
  - `sync_decision_receipts(repo: Repository, project_id: str, decisions: list[Decision], *, attempts: int = 5) -> int` — appends every missing decision receipt in occurrence order; never raises; returns the number written.
  - `append_receipt(repo: Repository, draft: ReceiptDraft, *, attempts: int = 5) -> Receipt` — for non-derived events (roles, erasure); raises `ReceiptConflict` after `attempts` lost races and `DeliveryStoreUnavailable` when the table is missing.
  - Withdrawn decisions now carry `resolved_by` (the user whose new request withdrew them) and `resolved_at`.

- [ ] **Step 1: Write the failing unit tests**

`apps/cloud/tests/test_receipt_ledger.py`:

```python
"""Which receipts a decision implies, and how they are appended (D1)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import InMemoryRepository, ReceiptConflict
from app.delivery.ledger import append_receipt, expected_events, sync_decision_receipts
from app.delivery.receipts import sha256_text, verify_chain
from app.models.schemas import Decision, ReceiptDraft, utcnow


def _decision(status="open", **extra):
    now = utcnow()
    return Decision(
        project_id="p", workspace_id="w", kind="plan_approval", title="t",
        subject_stage="tasks", subject_hash="h" * 64, routed_hat="tech_steward",
        status=status, requested_by="bob", created_at=extra.pop("created_at", now), **extra,
    )


def test_an_open_decision_implies_one_requested_receipt():
    (at, draft), = expected_events(_decision())
    assert draft.event == "decision.requested" and draft.actor == "bob"
    assert draft.body["subject_hash"] == "h" * 64 and draft.body["routed_hat"] == "tech_steward"


def test_an_approval_records_the_resolver_and_only_a_hash_of_the_rationale():
    d = _decision("approved", resolved_by="alice", resolved_at=utcnow(), rationale="Looks right")
    events = expected_events(d)
    assert [e.event for _, e in events] == ["decision.requested", "decision.approved"]
    approved = events[1][1]
    assert approved.actor == "alice"
    assert approved.body["rationale_sha256"] == sha256_text("Looks right")
    assert "Looks right" not in str(approved.body)


def test_a_withdrawal_without_a_resolver_is_attributed_to_the_system():
    d = _decision("withdrawn")
    assert expected_events(d)[1][1].actor == "system"


def test_sync_appends_missing_receipts_in_occurrence_order_and_is_idempotent():
    repo = InMemoryRepository()
    t0 = utcnow()
    old = _decision("withdrawn", created_at=t0, resolved_by="bob",
                    resolved_at=t0 + timedelta(seconds=1))
    new = _decision(created_at=t0 + timedelta(seconds=2))

    assert sync_decision_receipts(repo, "p", [new, old]) == 3
    assert sync_decision_receipts(repo, "p", [new, old]) == 0

    chain = repo.list_receipts("p")
    assert [(r.subject_id, r.event) for r in chain] == [
        (old.id, "decision.requested"),
        (old.id, "decision.withdrawn"),
        (new.id, "decision.requested"),
    ]
    assert verify_chain(chain).ok


def test_sync_repairs_a_gap_left_by_an_earlier_failed_write():
    repo = InMemoryRepository()
    d = _decision()
    sync_decision_receipts(repo, "p", [d])
    resolved = d.model_copy(update={"status": "approved", "resolved_by": "alice",
                                    "resolved_at": utcnow()})
    # The approval's own sync never ran (crash); the next write repairs it.
    other = _decision()
    assert sync_decision_receipts(repo, "p", [other, resolved]) == 2
    assert [r.event for r in repo.list_receipts("p")][-2:] == [
        "decision.approved", "decision.requested"]


def test_sync_retries_after_losing_a_race():
    repo = InMemoryRepository()
    real_insert = repo.insert_receipt
    calls = {"n": 0}

    def flaky(receipt):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ReceiptConflict("seq taken")
        return real_insert(receipt)

    repo.insert_receipt = flaky
    assert sync_decision_receipts(repo, "p", [_decision()]) == 1
    assert len(repo.list_receipts("p")) == 1


def test_sync_never_raises_when_the_store_is_missing():
    repo = InMemoryRepository()

    def missing(_):
        from app.db.repository import DeliveryStoreUnavailable
        raise DeliveryStoreUnavailable()

    repo.insert_receipt = missing
    assert sync_decision_receipts(repo, "p", [_decision()]) == 0


def test_append_receipt_gives_up_after_the_attempts():
    repo = InMemoryRepository()

    def always(_):
        raise ReceiptConflict("seq taken")

    repo.insert_receipt = always
    draft = ReceiptDraft(project_id="p", workspace_id="w", event="role.assigned",
                         subject_type="project_role", subject_id="p:tech_steward", actor="a")
    with pytest.raises(ReceiptConflict):
        append_receipt(repo, draft, attempts=2)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_receipt_ledger.py`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.delivery.ledger'`.

- [ ] **Step 3: Write `app/delivery/ledger.py`**

```python
"""Which receipts the decision layer writes, and how (enterprise AI v2.1 D1).

Decision receipts are derived from the decision rows: `expected_events` says
which receipts a decision in its current state implies, and
`sync_decision_receipts` appends the ones the chain does not have yet. A
receipt write that fails (crash, lost race, store down) is therefore repaired
by the next decision write in the same project instead of being lost. Hat
changes and snapshot erasures are not derivable from a row, so they use
`append_receipt` directly.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.db.repository import DeliveryStoreUnavailable, ReceiptConflict, Repository
from app.delivery.receipts import seal, sha256_text, stamp
from app.models.schemas import Decision, Receipt, ReceiptDraft

logger = logging.getLogger("promptworkspace.receipts")

# Ties on the same timestamp: a request is recorded before its outcome.
_RANK = {"decision.requested": 0}


def expected_events(decision: Decision) -> list[tuple[datetime, ReceiptDraft]]:
    def draft(event: str, actor: str, at: datetime, **extra) -> tuple[datetime, ReceiptDraft]:
        body: dict[str, str | int | bool | None] = {
            "kind": decision.kind,
            "subject_stage": decision.subject_stage,
            "subject_hash": decision.subject_hash,
            "routed_hat": decision.routed_hat,
            "occurred_at": stamp(at),
            **extra,
        }
        return at, ReceiptDraft(
            project_id=decision.project_id, workspace_id=decision.workspace_id,
            event=event, subject_type="decision", subject_id=decision.id,
            actor=actor, body=body,
        )

    events = [draft("decision.requested", decision.requested_by, decision.created_at)]
    resolved_at = decision.resolved_at or decision.created_at
    if decision.status in ("approved", "rejected"):
        rationale = {"rationale_sha256": sha256_text(decision.rationale)} if decision.rationale else {}
        events.append(draft(f"decision.{decision.status}", decision.resolved_by or "system",
                            resolved_at, **rationale))
    elif decision.status == "withdrawn":
        events.append(draft("decision.withdrawn", decision.resolved_by or "system", resolved_at))
    elif decision.status == "expired":
        events.append(draft("decision.expired", "system", resolved_at))
    return events


def sync_decision_receipts(
    repo: Repository, project_id: str, decisions: list[Decision], *, attempts: int = 5
) -> int:
    written = 0
    for _ in range(attempts):
        try:
            chain = repo.list_receipts(project_id)
            have = {(r.subject_id, r.event) for r in chain if r.subject_type == "decision"}
            missing = sorted(
                (
                    (at, draft)
                    for d in decisions
                    for at, draft in expected_events(d)
                    if (draft.subject_id, draft.event) not in have
                ),
                key=lambda pair: (pair[0], _RANK.get(pair[1].event, 1)),
            )
            previous: Receipt | None = chain[-1] if chain else None
            for _, draft in missing:
                previous = repo.insert_receipt(seal(draft, previous))
                written += 1
            return written
        except ReceiptConflict:
            continue  # another writer extended the chain: re-read and seal again
        except DeliveryStoreUnavailable:
            logger.warning("receipt store unavailable, project=%s", project_id)
            return written
        except Exception:
            logger.exception("receipt sync failed, project=%s", project_id)
            return written
    logger.error("receipt sync lost %s races, project=%s", attempts, project_id)
    return written


def append_receipt(repo: Repository, draft: ReceiptDraft, *, attempts: int = 5) -> Receipt:
    for _ in range(attempts):
        chain = repo.list_receipts(draft.project_id)
        try:
            return repo.insert_receipt(seal(draft, chain[-1] if chain else None))
        except ReceiptConflict:
            continue
    raise ReceiptConflict(f"lost {attempts} races appending {draft.event}")
```

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_receipt_ledger.py`
Expected: 8 passed.

- [ ] **Step 5: Write the failing API tests**

Append to `apps/cloud/tests/test_decisions_api.py`:

```python
def _events(client, pid):
    return [(r.subject_id, r.event, r.actor)
            for r in client.app.state.repository.list_receipts(pid)]


def test_request_and_approval_each_leave_a_receipt(client, project):
    did = _request(client, project, "intent_approval").json()["id"]
    _resolve(client, project, did)

    assert _events(client, project) == [
        (did, "decision.requested", "bob"),
        (did, "decision.approved", "alice"),
    ]


def test_a_new_request_records_the_withdrawal_of_the_old_one_by_its_requester(client, project):
    repo = client.app.state.repository
    old = _request(client, project, "intent_approval").json()["id"]
    repo.upsert_stage_document(project, repo.get_project(project).workspace_id,
                               "specify", "# Spec\n\nBook two slots.", "alice")
    new = _request(client, project, "intent_approval").json()["id"]

    assert _events(client, project) == [
        (old, "decision.requested", "bob"),
        (old, "decision.withdrawn", "bob"),
        (new, "decision.requested", "bob"),
    ]


def test_assigning_and_clearing_a_hat_leaves_receipts(client, project):
    client.put(f"/projects/{project}/roles/tech_steward", json={"user_id": "bob"}, headers=ALICE)
    client.put(f"/projects/{project}/roles/tech_steward", json={"user_id": None}, headers=ALICE)

    assert [(e, a) for _, e, a in _events(client, project)] == [
        ("role.assigned", "alice"), ("role.cleared", "alice")]
```

- [ ] **Step 6: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decisions_api.py -k "receipt or withdrawal or hat_leaves"`
Expected: 3 FAIL (empty receipt lists).

- [ ] **Step 7: Wire the routes**

In `app/api/delivery.py`, import `from app.delivery.ledger import append_receipt, sync_decision_receipts` and `ReceiptDraft` from schemas.

In `request_decision`, change the withdraw line to record who withdrew it:

```python
            after[i] = repo.save_decision(existing.model_copy(
                update={"status": "withdrawn", "resolved_by": user.id, "resolved_at": utcnow()}))
```

and before the final `return _mutation_out(decision, …)` add:

```python
    sync_decision_receipts(repo, project_id, [decision, *after])
```

In `resolve_decision`, after `after = [resolved if d.id == resolved.id else d for d in decisions]`:

```python
    sync_decision_receipts(repo, project_id, after)
```

In `put_project_role`, after the `set_project_role` try/except:

```python
    try:
        append_receipt(repo, ReceiptDraft(
            project_id=project_id, workspace_id=project.workspace_id,
            event="role.assigned" if body.user_id else "role.cleared",
            subject_type="project_role", subject_id=f"{project_id}:{hat}",
            actor=user.id, body={"hat": hat, "user_id": body.user_id},
        ))
    except Exception:
        # The hat is set; a lost receipt is logged, not a failed request.
        logger.exception("role receipt failed, project=%s hat=%s", project_id, hat)
```

- [ ] **Step 8: Run the whole suite**

Run: `cd apps/cloud && .venv/bin/pytest -q`
Expected: all pass. If a test asserted that a withdrawn decision has `resolved_by is None`, update it to expect the withdrawing user.

- [ ] **Step 9: Commit**

```bash
git add apps/cloud/app/delivery/ledger.py apps/cloud/app/api/delivery.py apps/cloud/tests/test_receipt_ledger.py apps/cloud/tests/test_decisions_api.py
git commit -m "feat(cloud): receipt for every decision and hat transition, self-repairing"
```

---

### Task 5: Receipts API — listing with verification, JSONL export

**Files:**
- Create: `apps/cloud/app/api/receipts.py`
- Modify: `apps/cloud/app/main.py` (import list and `app.include_router(delivery.router)` line ~298)
- Test: `apps/cloud/tests/test_receipts_api.py`

**Interfaces:**
- Consumes: `verify_chain`, `ChainCheck` (Task 2); `list_receipts` (Task 3).
- Produces:
  - `GET /projects/{project_id}/receipts` → `ReceiptsOut {receipts: ReceiptOut[], verification: {ok, count, head, broken_at, reason}}`; any workspace member.
  - `GET /projects/{project_id}/receipts.jsonl` → `application/x-ndjson`, one receipt JSON per line, `Content-Disposition: attachment; filename="receipts-<project_id>.jsonl"`; any workspace member.

- [ ] **Step 1: Write the failing tests**

`apps/cloud/tests/test_receipts_api.py`:

```python
"""Receipts API (D1): read the chain with its verification, export it."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.delivery.receipts import receipt_hash, verify_chain
from app.main import create_app
from app.models.schemas import Receipt

ALICE = {"X-User-Id": "alice"}
EVE = {"X-User-Id": "eve"}


@pytest.fixture
def client():
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def project(client):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    pid = client.post("/projects", json={"name": "P", "workspace_id": ws["id"]},
                      headers=ALICE).json()["id"]
    for user in ("u1", "u2", None):
        client.put(f"/projects/{pid}/roles/tech_steward", json={"user_id": user}, headers=ALICE)
    return pid


def test_members_read_the_chain_with_a_passing_verification(client, project):
    # u1/u2 are not members, so only the final clear succeeds: one receipt.
    body = client.get(f"/projects/{project}/receipts", headers=ALICE).json()
    assert [r["event"] for r in body["receipts"]] == ["role.cleared"]
    assert body["verification"] == {"ok": True, "count": 1,
                                    "head": body["receipts"][0]["hash"],
                                    "broken_at": None, "reason": None}


def test_a_tampered_receipt_is_reported(client, project):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": None}, headers=ALICE)
    chain = client.app.state.repository._receipts[project]
    chain[0] = chain[0].model_copy(update={"actor": "mallory"})

    body = client.get(f"/projects/{project}/receipts", headers=ALICE).json()
    assert body["verification"]["ok"] is False
    assert body["verification"]["broken_at"] == 1
    assert body["verification"]["reason"] == "hash_mismatch"


def test_the_export_is_one_receipt_per_line_and_verifies_offline(client, project):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": None}, headers=ALICE)
    res = client.get(f"/projects/{project}/receipts.jsonl", headers=ALICE)

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/x-ndjson")
    assert f'receipts-{project}.jsonl' in res.headers["content-disposition"]
    receipts = [Receipt(**json.loads(line)) for line in res.text.splitlines()]
    assert len(receipts) == 2
    assert all(receipt_hash(r) == r.hash for r in receipts)
    assert verify_chain(receipts).ok


def test_non_members_cannot_read_receipts(client, project):
    assert client.get(f"/projects/{project}/receipts", headers=EVE).status_code == 403
    assert client.get(f"/projects/{project}/receipts.jsonl", headers=EVE).status_code == 403
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_receipts_api.py`
Expected: FAIL, 404 on `/receipts`.

- [ ] **Step 3: Write the router**

`apps/cloud/app/api/receipts.py`:

```python
"""Receipt chain routes (enterprise AI v2.1 D1): read a project's chain with
its verification, and export it as JSON lines an auditor verifies offline
with app/delivery/receipts.py::verify_chain."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from app.api._guards import require_project
from app.db.repository import Repository
from app.delivery.receipts import verify_chain
from app.dependencies import User, get_current_user, get_repository

router = APIRouter(tags=["receipts"])


class ReceiptOut(BaseModel):
    id: str
    project_id: str
    workspace_id: str
    seq: int
    event: str
    subject_type: str
    subject_id: str
    actor: str
    body: dict[str, str | int | bool | None]
    prev_hash: str
    hash: str
    created_at: datetime


class ChainCheckOut(BaseModel):
    ok: bool
    count: int
    head: str | None
    broken_at: int | None
    reason: str | None


class ReceiptsOut(BaseModel):
    receipts: list[ReceiptOut]
    verification: ChainCheckOut


@router.get("/projects/{project_id}/receipts", response_model=ReceiptsOut)
def list_project_receipts(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ReceiptsOut:
    require_project(repo, project_id, user)
    chain = repo.list_receipts(project_id)
    return ReceiptsOut(
        receipts=[ReceiptOut(**r.model_dump()) for r in chain],
        verification=ChainCheckOut(**asdict(verify_chain(chain))),
    )


@router.get("/projects/{project_id}/receipts.jsonl")
def export_project_receipts(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> PlainTextResponse:
    require_project(repo, project_id, user)
    lines = "".join(r.model_dump_json() + "\n" for r in repo.list_receipts(project_id))
    return PlainTextResponse(
        lines,
        media_type="application/x-ndjson",
        headers={"Content-Disposition": f'attachment; filename="receipts-{project_id}.jsonl"'},
    )
```

In `app/main.py`, add `receipts` to the `from app.api import …` list and `app.include_router(receipts.router)` after `app.include_router(delivery.router)`.

Note: `Receipt.model_dump_json()` writes `created_at` with Pydantic's ISO form; `stamp()` normalises it again on verification, so the export verifies offline (the test pins this).

- [ ] **Step 4: Run the tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_receipts_api.py && .venv/bin/pytest -q`
Expected: 4 passed; full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/api/receipts.py apps/cloud/app/main.py apps/cloud/tests/test_receipts_api.py
git commit -m "feat(cloud): receipts listing with chain verification and JSONL export"
```

---

### Task 6: No self-approval, and say who is blocked

**Files:**
- Modify: `apps/cloud/app/delivery/decisions.py`
- Modify: `apps/cloud/app/api/delivery.py` (`DecisionBase` ~line 176, `decision_out` ~line 247, `_read_listing` ~line 330, `request_decision`, `resolve_decision`)
- Test: `apps/cloud/tests/test_decision_rules.py` (append), `apps/cloud/tests/test_decisions_api.py` (append; fix any existing self-approving test)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Blocked = Literal["own_request", "no_approver"]`
  - `eligible_resolvers(decision: Decision, roles: list[ProjectRole], member_ids: set[str], admin_ids: set[str]) -> set[str]` — everyone who may resolve, requester excluded.
  - `blocked_reason(decision, user_id, roles, member_ids, admin_ids) -> Blocked | None`
  - `can_resolve(...)` keeps its signature and now returns False for the requester.
  - `admin_ids_of(members: list[WorkspaceMember], user_id: str, is_admin: bool) -> set[str]` in `app/api/delivery.py`.
  - `DecisionBase.blocked: Literal["own_request", "no_approver"] | None = None` in API responses.
  - Resolve by the requester → 403 `self_approval_not_allowed`.

- [ ] **Step 1: Write the failing rule tests**

Append to `apps/cloud/tests/test_decision_rules.py`:

```python
from app.delivery.decisions import blocked_reason, eligible_resolvers


def test_the_requester_never_resolves_their_own_decision():
    d = _decision()  # requested_by="u"
    assert not can_resolve(d, "u", [], {"u"}, is_admin=True)
    assert not can_resolve(d, "u", [_role("u")], {"u"}, is_admin=False)


def test_eligible_resolvers_exclude_the_requester():
    d = _decision()
    assert eligible_resolvers(d, [], {"u", "a1", "a2"}, {"u", "a1", "a2"}) == {"a1", "a2"}
    assert eligible_resolvers(d, [_role("steve")], {"steve"}, {"a1"}) == {"steve"}
    assert eligible_resolvers(d, [_role("u")], {"u", "a1"}, {"a1"}) == set()


def test_a_solo_admin_request_has_no_approver():
    d = _decision()
    assert blocked_reason(d, "u", [], {"u"}, {"u"}) == "no_approver"


def test_the_requester_sees_own_request_when_someone_else_can_approve():
    d = _decision()
    assert blocked_reason(d, "u", [], {"u", "a1"}, {"a1"}) == "own_request"
    assert blocked_reason(d, "a1", [], {"u", "a1"}, {"a1"}) is None


def test_a_resolved_decision_is_never_blocked():
    assert blocked_reason(_decision("approved"), "u", [], {"u"}, {"u"}) is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_rules.py`
Expected: FAIL, `ImportError: cannot import name 'blocked_reason'`.

- [ ] **Step 3: Implement the rules**

In `app/delivery/decisions.py`, update the module docstring's routing sentence to add: "The requester never resolves their own decision (v2.1 View 1: no self-approval), even when they are the only person who could." Then replace `can_resolve` and add:

```python
Blocked = Literal["own_request", "no_approver"]


def eligible_resolvers(
    decision: Decision,
    roles: list[ProjectRole],
    member_ids: set[str],
    admin_ids: set[str],
) -> set[str]:
    """Everyone who may resolve `decision`: the hat holder while they are a
    member, otherwise the workspace admins. Never the requester."""
    holder = next((r.user_id for r in roles if r.hat == decision.routed_hat), None)
    pool = {holder} if holder is not None and holder in member_ids else set(admin_ids)
    return pool - {decision.requested_by}


def blocked_reason(
    decision: Decision,
    user_id: str,
    roles: list[ProjectRole],
    member_ids: set[str],
    admin_ids: set[str],
) -> Blocked | None:
    """Why an open decision is stuck, as `user_id` should be told: nobody but
    the requester could approve it, or `user_id` is the requester."""
    if decision.status != "open":
        return None
    if not eligible_resolvers(decision, roles, member_ids, admin_ids):
        return "no_approver"
    if user_id == decision.requested_by:
        return "own_request"
    return None


def can_resolve(
    decision: Decision,
    user_id: str,
    roles: list[ProjectRole],
    member_ids: set[str],
    is_admin: bool,
) -> bool:
    if decision.status != "open" or user_id == decision.requested_by:
        return False
    holder = next((r.user_id for r in roles if r.hat == decision.routed_hat), None)
    if holder is not None and holder in member_ids:
        return holder == user_id
    return is_admin
```

- [ ] **Step 4: Run the rule tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_rules.py`
Expected: all pass.

- [ ] **Step 5: Write the failing API tests**

Append to `apps/cloud/tests/test_decisions_api.py`:

```python
def test_the_requester_cannot_approve_their_own_request(client, project):
    did = _request(client, project, "intent_approval", headers=ALICE).json()["id"]

    res = _resolve(client, project, did, headers=ALICE)

    assert res.status_code == 403
    assert res.json()["detail"] == "self_approval_not_allowed"


def test_a_request_nobody_else_can_approve_says_so(client, project):
    # Alice is the only admin and no hat is assigned: only Alice could approve.
    body = _request(client, project, "intent_approval", headers=ALICE).json()
    assert body["can_resolve"] is False and body["blocked"] == "no_approver"


def test_the_requester_is_told_it_is_their_own_request(client, project):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": "bob"},
               headers=ALICE)
    body = _request(client, project, "intent_approval", headers=ALICE).json()
    assert body["blocked"] == "own_request"
    listing = client.get(f"/projects/{project}/decisions", headers=BOB).json()
    assert listing["decisions"][0]["blocked"] is None
    assert listing["decisions"][0]["can_resolve"] is True
```

- [ ] **Step 6: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decisions_api.py -k "own_request or self_approve or nobody_else or their_own"`
Expected: FAIL (`blocked` missing; resolve returns 200).

- [ ] **Step 7: Wire the API**

In `app/api/delivery.py`:

1. Import `Blocked, blocked_reason` from `app.delivery.decisions`.
2. Add to `DecisionBase`, after `can_resolve: bool`:

```python
    # Why an open decision is stuck for this caller: "no_approver" (nobody but
    # the requester could approve it: assign the hat to someone else) or
    # "own_request" (the caller asked; someone else approves).
    blocked: Blocked | None = None
```

3. Add a helper after `_routing_context` (keep `_routing_context`'s 3-tuple: `app/api/me.py` unpacks it):

```python
def admin_ids_of(members: list[WorkspaceMember], user_id: str, is_admin: bool) -> set[str]:
    """The workspace admins on the member page, plus the caller when they are
    one (see `_routing_context` on the page limit)."""
    ids = {m.user_id for m in members if m.role == Role.admin}
    return ids | {user_id} if is_admin else ids
```

4. `decision_out` gains a keyword `admin_ids: set[str] = frozenset()` and sets
`blocked=blocked_reason(decision, user_id, roles, member_ids, admin_ids)` in the `DecisionOut(...)` call.
5. In `_read_listing`, `request_decision` and `resolve_decision`, where `out = partial(decision_out, …)` is built, pass `admin_ids=admin_ids_of(members, user.id, is_admin)`.
6. In `resolve_decision`, before the `can_resolve` check:

```python
    if decision.requested_by == user.id:
        raise HTTPException(status_code=403, detail="self_approval_not_allowed")
```

- [ ] **Step 8: Run the whole suite and fix self-approving tests**

Run: `cd apps/cloud && .venv/bin/pytest -q`
Expected: the new tests pass. Existing tests that request and resolve as the same user now fail with 403 (look in `test_decisions_api.py`, `test_delivery_gate.py`, `test_repository_docs*.py`, `test_delivery_round_trips.py`). Fix each by making a different member request (BOB) or resolve; never by weakening the rule. Re-run until green.

- [ ] **Step 9: Commit**

```bash
git add apps/cloud/app/delivery/decisions.py apps/cloud/app/api/delivery.py apps/cloud/tests/
git commit -m "feat(cloud): no self-approval; decisions say why they are blocked"
```

---

### Task 7: Erasable decision snapshots (migration 0008)

**Files:**
- Create: `apps/cloud/migrations/0008_pw_decision_snapshots.sql`
- Modify: `apps/cloud/app/db/repository.py` (abstract method; in-memory `__init__`, `list_decisions`, `get_decision`, `save_decision`)
- Modify: `apps/cloud/app/db/supabase_repository.py` (`_SNAPSHOTS`, `_SERVICE_ONLY_TABLES`, `list_decisions`, `get_decision`, `save_decision`, new method)
- Modify: `apps/cloud/app/api/delivery.py` (new route)
- Test: `apps/cloud/tests/contract/test_delivery_store.py` (append), `apps/cloud/tests/test_decisions_api.py` (append)

**Interfaces:**
- Consumes: `append_receipt` (Task 4), `sha256_text` (Task 2).
- Produces:
  - `Repository.erase_decision_snapshot(project_id: str, decision_id: str, erased_by: str) -> bool` — True when content was erased by this call; False when already erased or none stored.
  - `Decision.subject_content` keeps its meaning for every caller; storage moves to `pw_decision_snapshots`.
  - `POST /projects/{project_id}/decisions/{decision_id}/erase-snapshot` body `{"reason": str}` (non-blank), admin only → `{"erased": bool}`; 404 `decision_not_found`; 422 `reason_required`; 503 `receipt_write_failed` (retry-safe).

- [ ] **Step 1: Write the failing contract tests**

Append to `apps/cloud/tests/contract/test_delivery_store.py` (reuse its imports; add `Decision` if missing):

```python
def _snap_decision(project, ws, content="# Spec\n\nPatient: Somchai, 081-234-5678"):
    return Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval", title="t",
        subject_stage="specify", subject_hash="h" * 64, subject_content=content,
        routed_hat="business_owner", requested_by="bob",
    )


def test_snapshot_content_round_trips_through_its_own_store(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = repo.save_decision(_snap_decision(project, ws))

    assert repo.get_decision(project.id, d.id).subject_content.startswith("# Spec")
    assert repo.list_decisions(project.id)[0].subject_content.startswith("# Spec")


def test_resaving_a_decision_does_not_replace_its_snapshot(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = repo.save_decision(_snap_decision(project, ws))
    repo.save_decision(d.model_copy(update={"status": "approved", "subject_content": "other"}))

    assert repo.get_decision(project.id, d.id).subject_content.startswith("# Spec")


def test_erasing_a_snapshot_keeps_the_decision_and_its_hash(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = repo.save_decision(_snap_decision(project, ws))

    assert repo.erase_decision_snapshot(project.id, d.id, admin) is True
    assert repo.erase_decision_snapshot(project.id, d.id, admin) is False

    stored = repo.get_decision(project.id, d.id)
    assert stored.subject_content is None and stored.subject_hash == "h" * 64
    # A later save of the decision must not bring the content back.
    repo.save_decision(stored.model_copy(update={"status": "approved"}))
    assert repo.get_decision(project.id, d.id).subject_content is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q -m contract tests/contract/test_delivery_store.py -k snapshot`
Expected: FAIL, `AttributeError: … 'erase_decision_snapshot'` (and the resave test fails on memory: content replaced).

- [ ] **Step 3: Write migration 0008**

`apps/cloud/migrations/0008_pw_decision_snapshots.sql`:

```sql
-- 0008_pw_decision_snapshots — erasable decision snapshots (enterprise AI v2.1 D1).
--
-- THE PROBLEM
-- pw_decisions.subject_content (0006) keeps the approved document's text on
-- the decision row. Plan documents can hold personal data, and Thai PDPA
-- erasure must remove it without touching the decision or its receipts.
--
-- SHAPE
-- pw_decision_snapshots: one row per decision, written once at request time.
-- Erasure nulls `content` and stamps `erased_at`/`erased_by`; the decision
-- keeps `subject_hash`, and the receipt chain (0007) only ever held the hash.
-- Existing snapshots are copied here and the old column is cleared. The
-- column itself is dropped by a later migration (plan 0029 §13 item 19).
--
-- GRANTS
-- Service-only from birth.
--
-- DEPLOY ORDER
-- Apply BEFORE deploying the code that writes snapshots here: that code
-- answers 503 delivery_store_unavailable on a request when the table is
-- missing. Code still running from before reads the cleared column as "no
-- snapshot", which the web already renders.

create table if not exists pw_decision_snapshots (
    decision_id uuid primary key references pw_decisions (id) on delete cascade,
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null references pw_workspaces (id) on delete cascade,
    content text,
    created_at timestamptz not null default now(),
    erased_at timestamptz,
    erased_by text,
    check ((content is null) = (erased_at is not null))
);

insert into pw_decision_snapshots (decision_id, project_id, workspace_id, content, created_at)
select id, project_id, workspace_id, subject_content, created_at
from pw_decisions
where subject_content is not null
on conflict (decision_id) do nothing;

update pw_decisions set subject_content = null where subject_content is not null;

alter table pw_decision_snapshots enable row level security;
revoke all on pw_decision_snapshots from authenticated;
revoke all on pw_decision_snapshots from anon;
grant select, insert, update on pw_decision_snapshots to service_role;
```

- [ ] **Step 4: Abstract method and in-memory adapter**

In `Repository`:

```python
    @abc.abstractmethod
    def erase_decision_snapshot(self, project_id: str, decision_id: str, erased_by: str) -> bool:
        """Null the stored document text of one decision. True when this call
        erased it; False when it was already erased or never stored."""
```

In `InMemoryRepository.__init__`, add
`self._snapshots: dict[str, dict] = {}  # decision_id -> {"content", "erased_at", "erased_by"}`.
Replace the three in-memory decision methods:

```python
    def _with_snapshot(self, decision: Decision) -> Decision:
        snap = self._snapshots.get(decision.id)
        content = snap["content"] if snap is not None else decision.subject_content
        return decision.model_copy(update={"subject_content": content}, deep=True)

    def list_decisions(self, project_id: str) -> list[Decision]:
        rows = [d for d in self._decisions.values() if d.project_id == project_id]
        rows.sort(key=lambda d: (d.created_at, d.id), reverse=True)
        return [self._with_snapshot(d) for d in rows]

    def get_decision(self, project_id: str, decision_id: str) -> Decision | None:
        row = self._decisions.get(decision_id)
        if row is None or row.project_id != project_id:
            return None
        return self._with_snapshot(row)

    def save_decision(self, decision: Decision) -> Decision:
        if decision.subject_content is not None and decision.id not in self._snapshots:
            self._snapshots[decision.id] = {
                "content": decision.subject_content, "erased_at": None, "erased_by": None}
        self._decisions[decision.id] = decision.model_copy(
            update={"subject_content": None}, deep=True)
        return copy.deepcopy(decision)

    def erase_decision_snapshot(self, project_id: str, decision_id: str, erased_by: str) -> bool:
        row = self._decisions.get(decision_id)
        snap = self._snapshots.get(decision_id)
        if row is None or row.project_id != project_id or snap is None or snap["content"] is None:
            return False
        snap.update(content=None, erased_at=utcnow(), erased_by=erased_by)
        return True
```

- [ ] **Step 5: Supabase adapter**

Add `_SNAPSHOTS = "pw_decision_snapshots"` and add it to `_SERVICE_ONLY_TABLES`. Add helpers and change the decision methods:

```python
    def _snapshot_contents(self, decision_ids: list[str]) -> dict[str, str | None]:
        """decision_id -> stored text (None when erased). Ids with no row are
        absent, so the caller falls back to the pre-0008 column."""
        if not decision_ids:
            return {}
        try:
            res = (
                self._table(_SNAPSHOTS)
                .select("decision_id,content")
                .in_("decision_id", decision_ids)
                .execute()
            )
        except Exception as exc:
            if self._missing_table(exc):
                return {}
            raise
        return {row["decision_id"]: row["content"] for row in res.data or []}

    @staticmethod
    def _decision_of(row: dict, snapshots: dict[str, str | None]) -> Decision:
        if row["id"] in snapshots:
            row = {**row, "subject_content": snapshots[row["id"]]}
        return Decision(**row)
```

In `list_decisions`, replace the final return with:

```python
        rows = res.data or []
        snapshots = self._snapshot_contents([r["id"] for r in rows])
        return [self._decision_of(r, snapshots) for r in rows]
```

In `get_decision`, replace the final return with:

```python
        if not rows:
            return None
        return self._decision_of(rows[0], self._snapshot_contents([rows[0]["id"]]))
```

In `save_decision`, at the top: `content = decision.subject_content` and `row = _dump(decision.model_copy(update={"subject_content": None}))`. Keep the existing upsert and its 0006 fallback unchanged. After the decision upsert succeeds, add:

```python
        if content is not None:
            try:
                self._table(_SNAPSHOTS).upsert(
                    {"decision_id": decision.id, "project_id": decision.project_id,
                     "workspace_id": decision.workspace_id, "content": content},
                    on_conflict="decision_id",
                    ignore_duplicates=True,  # written once; never replaced or revived
                ).execute()
            except Exception as exc:
                if self._missing_table(exc):
                    raise DeliveryStoreUnavailable() from exc
                raise
```

And the new method:

```python
    def erase_decision_snapshot(self, project_id: str, decision_id: str, erased_by: str) -> bool:
        try:
            res = (
                self._table(_SNAPSHOTS)
                .update({"content": None, "erased_at": utcnow().isoformat(),
                         "erased_by": erased_by})
                .eq("decision_id", decision_id)
                .eq("project_id", project_id)
                .is_("erased_at", "null")
                .execute()
            )
        except Exception as exc:
            if self._missing_table(exc):
                raise DeliveryStoreUnavailable() from exc
            raise
        # A pre-0008 copy on the decision row goes too.
        self._table(_DECISIONS).update({"subject_content": None}).eq("id", decision_id).execute()
        return bool(res.data)
```

- [ ] **Step 6: Run the contract tests**

Run: `cd apps/cloud && .venv/bin/pytest -q -m contract tests/contract/test_delivery_store.py`
Expected: all pass on memory (supabase skipped unless configured; run it against local Supabase when available).

- [ ] **Step 7: Write the failing API tests**

Append to `apps/cloud/tests/test_decisions_api.py`:

```python
def _erase(client, pid, did, reason="PDPA request 2026-10-14", headers=ALICE):
    return client.post(f"/projects/{pid}/decisions/{did}/erase-snapshot",
                       json={"reason": reason}, headers=headers)


def test_an_admin_erases_a_snapshot_and_the_chain_still_verifies(client, project):
    from app.delivery.receipts import verify_chain

    did = _request(client, project, "intent_approval").json()["id"]
    _resolve(client, project, did)
    state_before = client.get(f"/projects/{project}/decisions", headers=ALICE).json()["states"]

    res = _erase(client, project, did)

    assert res.status_code == 200 and res.json() == {"erased": True}
    listing = client.get(f"/projects/{project}/decisions", headers=ALICE).json()
    assert listing["decisions"][0]["subject_content"] is None
    assert listing["states"] == state_before
    chain = client.app.state.repository.list_receipts(project)
    assert chain[-1].event == "decision.snapshot_erased"
    assert "PDPA" not in str(chain[-1].body)
    assert verify_chain(chain).ok


def test_erasing_twice_records_one_receipt(client, project):
    did = _request(client, project, "intent_approval").json()["id"]
    _erase(client, project, did)
    assert _erase(client, project, did).json() == {"erased": False}
    events = [e for _, e, _ in _events(client, project)]
    assert events.count("decision.snapshot_erased") == 1


def test_only_admins_erase_and_a_reason_is_required(client, project):
    did = _request(client, project, "intent_approval").json()["id"]
    assert _erase(client, project, did, headers=BOB).status_code == 403
    assert _erase(client, project, did, reason="  ").json()["detail"] == "reason_required"
    assert _erase(client, project, "nope").status_code == 404
```

- [ ] **Step 8: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decisions_api.py -k erase`
Expected: FAIL, 404/405 on the route.

- [ ] **Step 9: Add the route**

In `app/api/delivery.py` (import `sha256_text` from `app.delivery.receipts`; `ReceiptConflict` from `app.db.repository`):

```python
class SnapshotErase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str


class SnapshotEraseOut(BaseModel):
    erased: bool


@router.post("/projects/{project_id}/decisions/{decision_id}/erase-snapshot",
             response_model=SnapshotEraseOut)
def erase_decision_snapshot(
    project_id: str,
    decision_id: str,
    body: SnapshotErase,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> SnapshotEraseOut:
    """Erase the document text a decision stored (PDPA erasure). The decision,
    its hash and every receipt stay; one `decision.snapshot_erased` receipt
    records who erased it, with only a hash of the reason. Safe to retry."""
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(status_code=422, detail="reason_required")
    if repo.get_decision(project_id, decision_id) is None:
        raise HTTPException(status_code=404, detail="decision_not_found")
    try:
        erased = repo.erase_decision_snapshot(project_id, decision_id, user.id)
    except DeliveryStoreUnavailable:
        raise HTTPException(status_code=503, detail="delivery_store_unavailable") from None
    recorded = any(
        r.subject_id == decision_id and r.event == "decision.snapshot_erased"
        for r in repo.list_receipts(project_id)
    )
    if not recorded and (erased or repo.get_decision(project_id, decision_id).subject_content is None):
        try:
            append_receipt(repo, ReceiptDraft(
                project_id=project_id, workspace_id=project.workspace_id,
                event="decision.snapshot_erased", subject_type="decision",
                subject_id=decision_id, actor=user.id,
                body={"reason_sha256": sha256_text(reason)},
            ))
        except (ReceiptConflict, DeliveryStoreUnavailable):
            raise HTTPException(status_code=503, detail="receipt_write_failed") from None
    return SnapshotEraseOut(erased=erased)
```

- [ ] **Step 10: Run the whole suite**

Run: `cd apps/cloud && .venv/bin/pytest -q`
Expected: green. Tests that read `repo._decisions[...]` directly for `subject_content` (grep `_decisions\[`) must read through `repo.get_decision` instead.

- [ ] **Step 11: Commit**

```bash
git add apps/cloud/migrations/0008_pw_decision_snapshots.sql apps/cloud/app/db/ apps/cloud/app/api/delivery.py apps/cloud/tests/
git commit -m "feat(cloud): erasable decision snapshots (migration 0008) with an erasure receipt"
```

---

### Task 8: Email the people who must decide

**Files:**
- Create: `apps/cloud/app/decision_email.py`, `apps/cloud/app/delivery/notices.py`
- Modify: `apps/cloud/app/config.py` (Settings, near `web_app_url` line ~68), `apps/cloud/app/main.py` (lifespan, next to `invitation_mailer` ~line 220), `apps/cloud/app/api/delivery.py` (`request_decision`, `put_project_role`)
- Test: `apps/cloud/tests/test_decision_email.py`, `apps/cloud/tests/test_decisions_api.py` (append)

**Interfaces:**
- Consumes: `eligible_resolvers` (Task 6), `admin_ids_of` (Task 6).
- Produces:
  - `DecisionMailer` protocol: `send(to: list[str], subject: str, text: str) -> bool`; `NullDecisionMailer`, `RecordingDecisionMailer` (`.sent: list[tuple[list[str], str, str]]`), `SmtpDecisionMailer(settings)`, `build_decision_mailer(settings) -> DecisionMailer`. App state: `app.state.decision_mailer`.
  - Settings: `smtp_host: str = ""`, `smtp_port: int = 587`, `smtp_user: str = ""`, `smtp_password: str = ""`, `smtp_from: str = ""`.
  - `notices.decision_link(web_app_url, decision) -> str`, `notices.recipients(user_ids, members) -> list[str]`, `notices.requested(decision, project_name, link) -> tuple[str, str]`, `notices.assigned(decisions, project_name, link, hat) -> tuple[str, str]`, `notices.reminder(decision, project_name, link) -> tuple[str, str]`, `notices.expired(decision, project_name, link) -> tuple[str, str]`.

- [ ] **Step 1: Write the failing unit tests**

`apps/cloud/tests/test_decision_email.py`:

```python
"""Decision notifications (D1): who is emailed, and what an email may say."""

from __future__ import annotations

from app.config import Settings
from app.decision_email import NullDecisionMailer, SmtpDecisionMailer, build_decision_mailer
from app.delivery import notices
from app.models.schemas import Decision, Role, WorkspaceMember


def _decision(**o):
    return Decision(project_id="p1", workspace_id="w1", kind="plan_approval",
                    title="Approve the delivery plan", subject_stage="tasks",
                    subject_hash="h", subject_content="Patient: Somchai 081-234-5678",
                    routed_hat="tech_steward", requested_by="bob", **o)


def test_the_link_opens_the_decisions_tab():
    assert notices.decision_link("https://w.example/", _decision()) == \
        "https://w.example/w/w1/p/p1?tab=decisions"


def test_recipients_are_the_members_emails_in_order_skipping_unknown():
    members = [WorkspaceMember(workspace_id="w1", user_id="a", email="a@x.com", role=Role.admin),
               WorkspaceMember(workspace_id="w1", user_id="b", email=None)]
    assert notices.recipients({"b", "a", "zz"}, members) == ["a@x.com"]


def test_a_request_email_names_the_decision_and_project_but_not_the_document():
    subject, text = notices.requested(_decision(), "Clinic booking", "https://l")
    assert subject == "[PromptWorkspace] Approve the delivery plan — Clinic booking"
    assert "https://l" in text and "tech steward" in text
    assert "Somchai" not in subject + text


def test_without_smtp_settings_nothing_is_sent():
    mailer = build_decision_mailer(Settings(smtp_host="", smtp_from=""))
    assert isinstance(mailer, NullDecisionMailer)
    assert mailer.send(["a@x.com"], "s", "t") is False


def test_with_smtp_settings_the_smtp_mailer_is_used():
    s = Settings(smtp_host="smtp-relay.brevo.com", smtp_from="PromptWorkspace <no-reply@x.com>")
    assert isinstance(build_decision_mailer(s), SmtpDecisionMailer)


def test_an_smtp_failure_is_reported_not_raised(monkeypatch):
    import smtplib

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(smtplib, "SMTP", boom)
    s = Settings(smtp_host="h", smtp_from="f@x.com")
    assert SmtpDecisionMailer(s).send(["a@x.com"], "s", "t") is False
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_email.py`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.decision_email'`.

- [ ] **Step 3: Settings**

In `app/config.py` `Settings`, after `web_app_url`:

```python
    # Decision notification email (enterprise AI v2.1 D1). The same SMTP relay
    # Supabase Auth uses (docs/DEPLOYMENT.md "Auth email"); Supabase itself
    # only sends auth email. Empty host or sender: notifications are off.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
```

- [ ] **Step 4: The mailer**

`apps/cloud/app/decision_email.py`:

```python
"""Best-effort decision notification email over SMTP (enterprise AI v2.1 D1).

Sending never blocks or fails a decision: the Decision Inbox is the source of
truth. One message per recipient, so recipients do not see each other.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Protocol

from app.config import Settings

logger = logging.getLogger("promptworkspace")


class DecisionMailer(Protocol):
    def send(self, to: list[str], subject: str, text: str) -> bool: ...


class NullDecisionMailer:
    """Sends nothing (SMTP not configured / tests)."""

    def send(self, to: list[str], subject: str, text: str) -> bool:  # noqa: D102
        return False


class RecordingDecisionMailer:
    """Keeps what would be sent. Tests install it on `app.state.decision_mailer`."""

    def __init__(self) -> None:
        self.sent: list[tuple[list[str], str, str]] = []

    def send(self, to: list[str], subject: str, text: str) -> bool:  # noqa: D102
        if not to:
            return False
        self.sent.append((list(to), subject, text))
        return True


class SmtpDecisionMailer:
    def __init__(self, settings: Settings) -> None:
        self._s = settings

    def send(self, to: list[str], subject: str, text: str) -> bool:
        if not to:
            return False
        try:
            with smtplib.SMTP(self._s.smtp_host, self._s.smtp_port, timeout=10) as smtp:
                smtp.starttls()
                if self._s.smtp_user:
                    smtp.login(self._s.smtp_user, self._s.smtp_password)
                for address in to:
                    msg = EmailMessage()
                    msg["From"] = self._s.smtp_from
                    msg["To"] = address
                    msg["Subject"] = subject
                    msg.set_content(text)
                    smtp.send_message(msg)
            return True
        except Exception as exc:  # noqa: BLE001 - email must never break a decision
            logger.warning("decision email not sent (%s recipients): %s", len(to), exc)
            return False


def build_decision_mailer(settings: Settings) -> DecisionMailer:
    if settings.smtp_host and settings.smtp_from:
        return SmtpDecisionMailer(settings)
    return NullDecisionMailer()
```

In `app/main.py` lifespan, after `app.state.invitation_mailer = …`:

```python
    from app.decision_email import build_decision_mailer

    app.state.decision_mailer = build_decision_mailer(settings)
```

- [ ] **Step 5: The notices**

`apps/cloud/app/delivery/notices.py`:

```python
"""What decision emails say (enterprise AI v2.1 D1). Pure. An email names the
decision, the project and where to answer it; it never carries the document,
which may hold personal data."""

from __future__ import annotations

from app.models.schemas import Decision, WorkspaceMember

HAT_LABEL = {"business_owner": "business owner", "tech_steward": "tech steward"}
_PREFIX = "[PromptWorkspace]"


def decision_link(web_app_url: str, decision: Decision) -> str:
    base = web_app_url.rstrip("/")
    return f"{base}/w/{decision.workspace_id}/p/{decision.project_id}?tab=decisions"


def recipients(user_ids: set[str], members: list[WorkspaceMember]) -> list[str]:
    return [m.email for m in members if m.user_id in user_ids and m.email]


def requested(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    return (
        f"{_PREFIX} {decision.title} — {project_name}",
        f"A decision in {project_name} is waiting for you as "
        f"{HAT_LABEL[decision.routed_hat]}: {decision.title}.\n\n"
        f"Read the document and decide: {link}\n\n"
        "Unanswered decisions expire, and an expired decision counts as no.\n",
    )


def assigned(decisions: list[Decision], project_name: str, link: str, hat: str) -> tuple[str, str]:
    titles = "\n".join(f"- {d.title}" for d in decisions)
    return (
        f"{_PREFIX} You are now {HAT_LABEL[hat]} — {project_name}",
        f"You were made {HAT_LABEL[hat]} of {project_name}. "
        f"These decisions are waiting for you:\n\n{titles}\n\nDecide here: {link}\n",
    )


def reminder(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    return (
        f"{_PREFIX} Reminder: {decision.title} — {project_name}",
        f"This decision in {project_name} expires soon: {decision.title}.\n\n"
        f"Decide here: {link}\n",
    )


def expired(decision: Decision, project_name: str, link: str) -> tuple[str, str]:
    return (
        f"{_PREFIX} Expired: {decision.title} — {project_name}",
        f"Nobody answered your request in {project_name} in time: {decision.title}. "
        f"It counts as not approved. Ask again when ready: {link}\n",
    )
```

- [ ] **Step 6: Run the unit tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_email.py`
Expected: 6 passed.

- [ ] **Step 7: Write the failing API tests**

Append to `apps/cloud/tests/test_decisions_api.py`:

```python
@pytest.fixture
def mailer(client):
    from app.decision_email import RecordingDecisionMailer

    client.app.state.decision_mailer = RecordingDecisionMailer()
    return client.app.state.decision_mailer


def test_a_request_emails_the_people_who_can_decide(client, project, mailer):
    _request(client, project, "intent_approval")  # Bob asks; admin Alice decides

    ((to, subject, _),) = mailer.sent
    assert to == ["alice@promptworkspace.local"]
    assert subject.startswith("[PromptWorkspace] Approve the intent")


def test_a_request_nobody_else_can_approve_sends_no_email(client, project, mailer):
    _request(client, project, "intent_approval", headers=ALICE)
    assert mailer.sent == []


def test_assigning_the_hat_emails_the_new_holder_their_open_decisions(client, project, mailer):
    _request(client, project, "intent_approval", headers=ALICE)  # blocked: no approver
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": "bob"},
               headers=ALICE)

    ((to, subject, text),) = mailer.sent
    assert to == ["bob@x.com"]
    assert "business owner" in subject and "Approve the intent" in text


def test_a_repeated_request_for_the_same_document_does_not_email_again(client, project, mailer):
    _request(client, project, "intent_approval")
    _request(client, project, "intent_approval")
    assert len(mailer.sent) == 1
```

Alice's stored email comes from stub auth (`app/dependencies.py`: `<uid>@promptworkspace.local`) via `create_workspace(created_by_email=…)`; Bob's from the accepted invitation (`bob@x.com`).

- [ ] **Step 8: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decisions_api.py -k email`
Expected: FAIL (`mailer.sent == []`).

- [ ] **Step 9: Send from the routes**

In `app/api/delivery.py`: import `BackgroundTasks, Request` from fastapi, `eligible_resolvers` from decisions, `notices` from `app.delivery`. Add a helper:

```python
def _email(request: Request, background: BackgroundTasks,
           to: list[str], message: tuple[str, str]) -> None:
    """Queue one notification after the response; never fails the request."""
    if to:
        background.add_task(request.app.state.decision_mailer.send, to, *message)
```

`request_decision` gains parameters `request: Request` and `background: BackgroundTasks`. Only for a *newly created* decision (not the two early returns), before the final return:

```python
    resolvers = eligible_resolvers(decision, roles, member_ids,
                                   admin_ids_of(members, user.id, is_admin))
    link = notices.decision_link(request.app.state.settings.web_app_url, decision)
    _email(request, background, notices.recipients(resolvers, members),
           notices.requested(decision, project.name, link))
```

`put_project_role` gains `request: Request` and `background: BackgroundTasks`. After the role receipt, when `body.user_id` is set:

```python
    if body.user_id is not None:
        waiting = [d for d in repo.list_decisions(project_id)
                   if d.status == "open" and d.routed_hat == hat
                   and d.requested_by != body.user_id]
        if waiting:
            members = repo.list_members(project.workspace_id)
            link = notices.decision_link(request.app.state.settings.web_app_url, waiting[0])
            _email(request, background, notices.recipients({body.user_id}, members),
                   notices.assigned(waiting, project.name, link, hat))
```

- [ ] **Step 10: Run the whole suite**

Run: `cd apps/cloud && .venv/bin/pytest -q`
Expected: green.

- [ ] **Step 11: Commit**

```bash
git add apps/cloud/app/decision_email.py apps/cloud/app/delivery/notices.py apps/cloud/app/config.py apps/cloud/app/main.py apps/cloud/app/api/delivery.py apps/cloud/tests/
git commit -m "feat(cloud): email the people who must decide (request and hat assignment)"
```

---

### Task 9: Decision expiry, reminder and the sweep (migration 0009)

**Files:**
- Create: `apps/cloud/migrations/0009_pw_decision_expiry.sql`, `apps/cloud/app/delivery/sweep.py`
- Modify: `apps/cloud/app/models/schemas.py` (`DecisionStatus`, `Decision`), `apps/cloud/app/delivery/decisions.py` (`latest_decision`, new `is_overdue`), `apps/cloud/app/config.py`, `apps/cloud/app/db/repository.py` + `apps/cloud/app/db/supabase_repository.py` (`list_due_decisions`), `apps/cloud/app/api/delivery.py` (request sets `expires_at`; resolve refuses overdue; request replaces an overdue open decision), `apps/cloud/app/main.py` (loop)
- Test: `apps/cloud/tests/test_decision_sweep.py`, `apps/cloud/tests/test_decision_rules.py` (append), `apps/cloud/tests/contract/test_delivery_store.py` (append), `apps/cloud/tests/test_decisions_api.py` (append)

**Interfaces:**
- Consumes: `sync_decision_receipts` (Task 4), mailer + notices (Task 8), `eligible_resolvers`, `admin_ids_of` (Task 6).
- Produces:
  - `DecisionStatus` gains `"expired"`; `Decision.expires_at: datetime | None = None`, `Decision.reminded_at: datetime | None = None`.
  - `is_overdue(decision: Decision, now: datetime) -> bool`.
  - `latest_decision` skips `withdrawn` **and** `expired`.
  - `Repository.list_due_decisions(until: datetime, limit: int = 200) -> list[Decision]` — open decisions with `expires_at <= until`, any project, oldest `expires_at` first.
  - Settings: `decision_ttl_days: int = 7`, `decision_reminder_hours: int = 48`, `decision_sweep_interval_seconds: int = 900` (0 disables the loop).
  - `sweep_decisions(repo, mailer, settings, now) -> SweepResult(expired: int, reminded: int)`.
  - Resolve of an overdue decision → 409 `decision_expired`.

- [ ] **Step 1: Write the failing rule tests**

Append to `apps/cloud/tests/test_decision_rules.py`:

```python
from app.delivery.decisions import is_overdue


def test_an_expired_decision_reads_like_no_decision():
    assert approval_state([_decision("expired")], "plan_approval", "h1") == "none"
    older = _decision("rejected", minutes_ago=5)
    assert approval_state([older, _decision("expired")], "plan_approval", "h1") == \
        "changes_requested"


def test_overdue_means_open_and_past_expiry():
    now = utcnow()
    assert is_overdue(_decision().model_copy(update={"expires_at": now}), now)
    assert not is_overdue(_decision().model_copy(
        update={"expires_at": now + timedelta(seconds=1)}), now)
    assert not is_overdue(_decision("approved").model_copy(update={"expires_at": now}), now)
    assert not is_overdue(_decision(), now)  # no expiry recorded (pre-0009)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_rules.py`
Expected: FAIL (`"expired"` rejected by `DecisionStatus`; `is_overdue` missing).

- [ ] **Step 3: Model and rules**

`schemas.py`: `DecisionStatus = Literal["open", "approved", "rejected", "withdrawn", "expired"]`; add to `Decision` after `resolved_at`:

```python
    # When an unanswered decision counts as no (v2.1 View 1: timeouts).
    # None for a decision made before migration 0009.
    expires_at: datetime | None = None
    # When the "expires soon" email went out; at most one per decision.
    reminded_at: datetime | None = None
```

`decisions.py`:

```python
def latest_decision(decisions: list[Decision], kind: str) -> Decision | None:
    """The newest decision of `kind` that was answered or still can be: the
    one a state reads. Withdrawn and expired decisions are skipped."""
    return max(
        (d for d in decisions if d.kind == kind and d.status not in ("withdrawn", "expired")),
        key=lambda d: (d.created_at, d.id),
        default=None,
    )


def is_overdue(decision: Decision, now: datetime) -> bool:
    return (
        decision.status == "open"
        and decision.expires_at is not None
        and decision.expires_at <= now
    )
```

(import `datetime` from `datetime`.) Also update the web's `Decision["status"]` union in Task 10.

- [ ] **Step 4: Run the rule tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_rules.py`
Expected: all pass.

- [ ] **Step 5: Migration 0009 and the store query**

`apps/cloud/migrations/0009_pw_decision_expiry.sql`:

```sql
-- 0009_pw_decision_expiry — unanswered decisions expire (enterprise AI v2.1 D1).
--
-- THE PROBLEM
-- An open decision waited forever. View 1: "unanswered means no", with
-- timeouts and a reminder.
--
-- SHAPE
-- expires_at: set at request time (DECISION_TTL_DAYS, default 7).
-- reminded_at: when the one "expires soon" email went out.
-- status gains 'expired', written by the sweep (app/delivery/sweep.py).
-- Decisions already open get a full term from today, so nothing expires on
-- the first sweep after this migration.
--
-- DEPLOY ORDER
-- Apply BEFORE deploying the code that writes expires_at: the Supabase
-- adapter writes every Decision field on save.

alter table pw_decisions add column if not exists expires_at timestamptz;
alter table pw_decisions add column if not exists reminded_at timestamptz;

update pw_decisions set expires_at = now() + interval '7 days'
where status = 'open' and expires_at is null;

alter table pw_decisions drop constraint if exists pw_decisions_status_check;
alter table pw_decisions add constraint pw_decisions_status_check
    check (status in ('open', 'approved', 'rejected', 'withdrawn', 'expired'));

create index if not exists idx_pw_decisions_due
    on pw_decisions (expires_at) where status = 'open';
```

Contract test, appended to `tests/contract/test_delivery_store.py`:

```python
def test_due_decisions_are_open_ones_expiring_by_the_cutoff(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    now = utcnow()

    def save(status, hours):
        return repo.save_decision(Decision(
            project_id=project.id, workspace_id=ws.id, kind="plan_approval", title="t",
            subject_stage="tasks", subject_hash="h", routed_hat="tech_steward",
            requested_by="bob", status=status, expires_at=now + timedelta(hours=hours)))

    soon, later = save("open", 1), save("open", 100)
    save("approved", 1)

    due = [d.id for d in repo.list_due_decisions(now + timedelta(hours=48))
           if d.project_id == project.id]
    assert due == [soon.id] and later.id not in due
```

Abstract method in `Repository`:

```python
    @abc.abstractmethod
    def list_due_decisions(self, until: datetime, limit: int = 200) -> list[Decision]:
        """Open decisions with expires_at <= until, in every project, soonest
        first. Service-level read for the sweep; empty when the column or
        table is missing."""
```

In-memory:

```python
    def list_due_decisions(self, until: datetime, limit: int = 200) -> list[Decision]:
        rows = [d for d in self._decisions.values()
                if d.status == "open" and d.expires_at is not None and d.expires_at <= until]
        rows.sort(key=lambda d: d.expires_at)
        return [self._with_snapshot(d) for d in rows[:limit]]
```

Supabase:

```python
    def list_due_decisions(self, until: datetime, limit: int = 200) -> list[Decision]:
        try:
            res = (
                self._table(_DECISIONS)
                .select("*")
                .eq("status", "open")
                .lte("expires_at", until.isoformat())
                .order("expires_at")
                .limit(limit)
                .execute()
            )
        except Exception as exc:
            if self._missing_table(exc) or getattr(exc, "code", None) in _MISSING_COLUMN_CODES:
                return []
            raise
        return [Decision(**row) for row in res.data or []]
```

(The sweep never needs document text, so no snapshot join here.)

Run: `cd apps/cloud && .venv/bin/pytest -q -m contract tests/contract/test_delivery_store.py`
Expected: pass.

- [ ] **Step 6: Write the failing sweep tests**

`apps/cloud/tests/test_decision_sweep.py`:

```python
"""The decision sweep (D1): reminders before expiry, expiry with a receipt."""

from __future__ import annotations

from datetime import timedelta

from app.config import Settings
from app.db.repository import InMemoryRepository
from app.decision_email import RecordingDecisionMailer
from app.delivery.sweep import sweep_decisions
from app.models.schemas import Decision, Role, utcnow

SETTINGS = Settings(decision_reminder_hours=48, web_app_url="https://w.example")


def _setup(hours_left: float, reminded=False):
    repo = InMemoryRepository()
    ws = repo.create_workspace("W", "alice", created_by_email="alice@x.com")
    repo.add_member(ws.id, "bob", Role.member, email="bob@x.com")
    project = repo.create_project(ws.id, "alice", "Clinic")
    now = utcnow()
    d = repo.save_decision(Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval",
        title="Approve the intent", subject_stage="specify", subject_hash="h",
        routed_hat="business_owner", requested_by="bob",
        created_at=now - timedelta(days=7),
        expires_at=now + timedelta(hours=hours_left),
        reminded_at=now if reminded else None))
    return repo, project, d, now


def test_a_decision_far_from_expiry_is_left_alone():
    repo, _, d, now = _setup(hours_left=100)
    mailer = RecordingDecisionMailer()
    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 0)
    assert mailer.sent == []


def test_a_decision_close_to_expiry_reminds_the_deciders_once():
    repo, project, d, now = _setup(hours_left=10)
    mailer = RecordingDecisionMailer()

    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 1)
    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 0)

    ((to, subject, _),) = mailer.sent
    assert to == ["alice@x.com"] and subject.startswith("[PromptWorkspace] Reminder")
    assert repo.get_decision(project.id, d.id).reminded_at is not None


def test_an_overdue_decision_expires_tells_the_requester_and_leaves_a_receipt():
    repo, project, d, now = _setup(hours_left=-1, reminded=True)
    mailer = RecordingDecisionMailer()

    assert sweep_decisions(repo, mailer, SETTINGS, now) == (1, 0)

    stored = repo.get_decision(project.id, d.id)
    assert stored.status == "expired" and stored.resolved_at == now
    assert [r.event for r in repo.list_receipts(project.id)] == [
        "decision.requested", "decision.expired"]
    ((to, subject, _),) = mailer.sent
    assert to == ["bob@x.com"] and subject.startswith("[PromptWorkspace] Expired")
```

- [ ] **Step 7: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_sweep.py`
Expected: FAIL, `ModuleNotFoundError: No module named 'app.delivery.sweep'`.

- [ ] **Step 8: Settings and the sweep**

Settings, after the SMTP fields:

```python
    # Decision timeouts (enterprise AI v2.1 D1).
    decision_ttl_days: int = 7
    decision_reminder_hours: int = 48
    decision_sweep_interval_seconds: int = 900  # 0 disables the sweep loop
```

`apps/cloud/app/delivery/sweep.py`:

```python
"""Decision timeouts (enterprise AI v2.1 D1, View 1: unanswered means no).

One pass: every open decision expiring within the reminder window gets one
reminder to the people who can decide; every overdue one becomes `expired`,
its requester is told, and its project's receipts are brought up to date.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import NamedTuple

from app.config import Settings
from app.db.repository import Repository
from app.decision_email import DecisionMailer
from app.delivery import notices
from app.delivery.decisions import eligible_resolvers, is_overdue
from app.delivery.ledger import sync_decision_receipts
from app.models.schemas import Role


class SweepResult(NamedTuple):
    expired: int
    reminded: int


def sweep_decisions(
    repo: Repository, mailer: DecisionMailer, settings: Settings, now: datetime
) -> SweepResult:
    expired = reminded = 0
    touched: set[str] = set()
    for d in repo.list_due_decisions(now + timedelta(hours=settings.decision_reminder_hours)):
        project = repo.get_project(d.project_id)
        if project is None:
            continue
        members = repo.list_members(d.workspace_id)
        link = notices.decision_link(settings.web_app_url, d)
        if is_overdue(d, now):
            repo.save_decision(d.model_copy(update={"status": "expired", "resolved_at": now}))
            mailer.send(notices.recipients({d.requested_by}, members),
                        *notices.expired(d, project.name, link))
            expired += 1
            touched.add(d.project_id)
        elif d.reminded_at is None:
            repo.save_decision(d.model_copy(update={"reminded_at": now}))
            admins = {m.user_id for m in members if m.role == Role.admin}
            resolvers = eligible_resolvers(d, repo.list_project_roles(d.project_id),
                                           {m.user_id for m in members}, admins)
            mailer.send(notices.recipients(resolvers, members),
                        *notices.reminder(d, project.name, link))
            reminded += 1
    for project_id in touched:
        sync_decision_receipts(repo, project_id, repo.list_decisions(project_id))
    return SweepResult(expired, reminded)
```

- [ ] **Step 9: Run the sweep tests**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decision_sweep.py`
Expected: 3 passed.

- [ ] **Step 10: Write the failing API tests**

Append to `apps/cloud/tests/test_decisions_api.py`:

```python
def test_a_request_expires_after_the_configured_term(client, project):
    body = _request(client, project, "intent_approval").json()
    d = client.app.state.repository.get_decision(project, body["id"])
    days = client.app.state.settings.decision_ttl_days
    assert timedelta(days=days) - timedelta(minutes=1) < d.expires_at - d.created_at \
        <= timedelta(days=days)


def test_an_overdue_decision_cannot_be_resolved_before_the_sweep_runs(client, project):
    repo = client.app.state.repository
    did = _request(client, project, "intent_approval").json()["id"]
    d = repo.get_decision(project, did)
    repo.save_decision(d.model_copy(update={"expires_at": utcnow() - timedelta(minutes=1)}))

    res = _resolve(client, project, did)
    assert res.status_code == 409 and res.json()["detail"] == "decision_expired"


def test_asking_again_replaces_an_overdue_request(client, project):
    repo = client.app.state.repository
    old = _request(client, project, "intent_approval").json()["id"]
    d = repo.get_decision(project, old)
    repo.save_decision(d.model_copy(update={"expires_at": utcnow() - timedelta(minutes=1)}))

    new = _request(client, project, "intent_approval").json()["id"]

    assert new != old
    assert repo.get_decision(project, old).status == "expired"
```

(`utcnow` and `timedelta` are already imported in this file; add `from app.models.schemas import utcnow` if not.)

- [ ] **Step 11: Run to verify failure**

Run: `cd apps/cloud && .venv/bin/pytest -q tests/test_decisions_api.py -k "expire or overdue"`
Expected: FAIL.

- [ ] **Step 12: Wire the routes and the loop**

`app/api/delivery.py` (import `timedelta`, `is_overdue`):

1. `request_decision` (already has `request: Request` from Task 8): set `expires_at=utcnow() + timedelta(days=request.app.state.settings.decision_ttl_days)` in the new `Decision(...)`. In the loop over existing open decisions, before the same-hash early return:

```python
            if is_overdue(existing, utcnow()):
                after[i] = repo.save_decision(existing.model_copy(
                    update={"status": "expired", "resolved_at": utcnow()}))
                continue
```

2. `resolve_decision`: after the `decision.status != "open"` check:

```python
    if is_overdue(decision, utcnow()):
        raise HTTPException(status_code=409, detail="decision_expired")
```

`app/main.py`, next to `_tombstone_gc_loop`:

```python
async def _decision_sweep_loop(app: FastAPI, settings: Settings) -> None:
    """Expire unanswered decisions and send reminders (enterprise AI v2.1 D1).
    Runs the sweep off the event loop: it sends SMTP mail."""
    if settings.decision_sweep_interval_seconds <= 0:
        return
    from app.delivery.sweep import sweep_decisions

    while True:
        await asyncio.sleep(settings.decision_sweep_interval_seconds)
        try:
            result = await asyncio.to_thread(
                sweep_decisions, app.state.repository, app.state.decision_mailer,
                settings, utcnow())
            if result.expired or result.reminded:
                logger.info("Decision sweep: %s expired, %s reminded", *result)
        except Exception:  # noqa: BLE001 - the sweep must never crash the app
            logger.exception("Decision sweep pass failed")
```

Start it beside `gc_task` (`sweep_task = asyncio.create_task(_decision_sweep_loop(app, settings))`) and cancel it in the `finally` block beside the others. Import `utcnow` from `app.models.schemas` if `main.py` does not already.

- [ ] **Step 13: Run the whole suite**

Run: `cd apps/cloud && .venv/bin/pytest -q`
Expected: green.

- [ ] **Step 14: Commit**

```bash
git add apps/cloud/migrations/0009_pw_decision_expiry.sql apps/cloud/app/ apps/cloud/tests/
git commit -m "feat(cloud): decisions expire with one reminder; sweep loop (migration 0009)"
```

---

### Task 10: Web — blocked and expired decisions

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Decision` at line ~724)
- Modify: `apps/web/src/components/project/DecisionsPanel.tsx` (`STATUS_LABEL` line ~19, the "Waiting on" paragraph line ~102)
- Test: `apps/web/src/components/project/DecisionsPanel.test.tsx` (append)

**Interfaces:**
- Consumes: API fields `blocked: "own_request" | "no_approver" | null`, `expires_at: string | null`, status `"expired"` (Tasks 6, 9).
- Produces: UI copy only.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("DecisionsPanel", …)` in `DecisionsPanel.test.tsx`:

```tsx
  it("tells the requester someone else approves their request", () => {
    decisions = {
      decisions: [decision({ can_resolve: false, blocked: "own_request" })],
      states: { intent: "none", plan: "pending" },
    };
    render(<DecisionsPanel workspaceId="w1" />);
    expect(
      screen.getByText("You asked for this. The tech steward approves it, not you."),
    ).toBeInTheDocument();
  });

  it("says when nobody else can approve and what to do", () => {
    decisions = {
      decisions: [decision({ can_resolve: false, blocked: "no_approver" })],
      states: { intent: "none", plan: "pending" },
    };
    render(<DecisionsPanel workspaceId="w1" />);
    expect(
      screen.getByText(
        "Nobody else can approve this yet. An admin can give the tech steward hat to another member.",
      ),
    ).toBeInTheDocument();
  });

  it("labels an expired decision and offers no actions", () => {
    decisions = {
      decisions: [decision({ status: "expired", can_resolve: false })],
      states: { intent: "none", plan: "none" },
    };
    render(<DecisionsPanel workspaceId="w1" />);
    expect(screen.getByText("Expired, not approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
```

Also add `blocked: null, expires_at: null, reminded_at: null,` to the `decision` factory defaults at the top of the file.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && pnpm test -- DecisionsPanel`
Expected: FAIL (texts not found; type errors on `blocked`).

- [ ] **Step 3: Types**

In `lib/types.ts` `Decision`: change `status` to `"open" | "approved" | "rejected" | "withdrawn" | "expired";` and add after `is_current`:

```ts
  /** Why an open decision is stuck for me: "own_request" (I asked; someone
   *  else approves) or "no_approver" (nobody but the requester could). */
  blocked: "own_request" | "no_approver" | null;
  /** When an unanswered decision counts as no. Null before the API set it. */
  expires_at: string | null;
  reminded_at: string | null;
```

- [ ] **Step 4: Panel**

In `DecisionsPanel.tsx`, add `expired: "Expired, not approved",` to `STATUS_LABEL`, and replace the `{decision.status === "open" && !decision.can_resolve && (…)}` block with:

```tsx
      {decision.status === "open" && !decision.can_resolve && (
        <p className="mt-2 text-xs text-slate-500">
          {decision.blocked === "no_approver"
            ? `Nobody else can approve this yet. An admin can give the ${HAT_LABEL[decision.routed_hat]} hat to another member.`
            : decision.blocked === "own_request"
              ? `You asked for this. The ${HAT_LABEL[decision.routed_hat]} approves it, not you.`
              : `Waiting on the ${HAT_LABEL[decision.routed_hat]}.`}
        </p>
      )}
```

Any other `Record<Decision["status"], …>` in the web (grep `Decision\["status"\]`) needs an `expired` entry too; `pnpm typecheck` lists them.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd apps/web && pnpm test && pnpm typecheck`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/components/project/
git commit -m "feat(web): show blocked and expired decisions"
```

---

### Task 11: Docs, full verification, push

**Files:**
- Modify: `docs/DEPLOYMENT.md` (env var table; "Auth email (custom SMTP)" section ~line 264; schema-apply section)
- Modify: `apps/cloud/README.md` (migrations table)
- Modify: `docs/plans/0029-agent-native-delivery.md` §13 (mark what D1 core closed)

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed `feature/d1-receipts` branch, ready for a PR to `develop` once PR #17 merges.

- [ ] **Step 1: DEPLOYMENT.md**

Add under the Auth email section a paragraph:

```markdown
#### Decision email (cloud API)

Supabase sends only auth email, so the API sends decision notifications itself (enterprise AI v2.1 D1) through the same SMTP relay. Set on the API service, per environment: `SMTP_HOST` (`smtp-relay.brevo.com`), `SMTP_PORT` (`587`), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (for example `PromptWorkspace <no-reply@truthledgers.com>` on develop). With `SMTP_HOST` or `SMTP_FROM` empty, decisions still work and no email is sent. Timeouts: `DECISION_TTL_DAYS` (default 7), `DECISION_REMINDER_HOURS` (48), `DECISION_SWEEP_INTERVAL_SECONDS` (900; 0 disables).
```

Add to the schema section: "Migrations 0008 and 0009 must be applied **before** deploying the D1 API; 0007 may go either side."

- [ ] **Step 2: README migrations table**

Add rows for 0007 (`pw_receipts`, append-only chain), 0008 (`pw_decision_snapshots`, erasable), 0009 (`pw_decisions.expires_at`, `reminded_at`, status `expired`), matching the table's existing format.

- [ ] **Step 3: Full verification**

Run, from the repository root:

```bash
cd apps/cloud && .venv/bin/pytest -q && .venv/bin/pytest -q -m contract && .venv/bin/ruff check . && cd ../web && pnpm test && pnpm typecheck
```

Expected: all green. If a local Supabase is available, also run the contract suite with the `PROMPTWORKSPACE_CONTRACT_SUPABASE_*` variables after `scripts/migrate.py apply` (review focus 2 only shows there).

- [ ] **Step 4: Placeholder scan of the branch**

Run: `git diff origin/feature/trust-outcome --stat && git diff origin/feature/trust-outcome | grep -nE "TODO|FIXME|xfail|\.skip\(|\.only\(" || true`
Expected: no new matches.

- [ ] **Step 5: Commit docs and push**

```bash
git add docs/DEPLOYMENT.md apps/cloud/README.md docs/plans/0029-agent-native-delivery.md
git commit -m "docs: D1 core deployment (SMTP, migration order) and plan 0029 status"
# Do NOT push (ledger ruling R4): the controller pushes after the final review.
```

- [ ] **Step 6: Hand back to the user (do not merge, do not deploy)**

Report: branch pushed; PR to `develop` to be opened after PR #17 merges; before deploying to any environment, apply migrations 0007–0009 there and set the SMTP variables; on the trust environment, a one-person workspace now needs a second member to approve (by decision, 2026-10-14). Run `gh pr checks` on the PR before calling it mergeable.

---

## Self-review notes

- Spec coverage (v2.1 plan §4 D1 row): append-only hash-chained receipt on every decision transition (Tasks 2–4), verifiable by export (Task 5); snapshots in an erasable store with only the hash in the chain (Task 7); separation of duties (Task 6); decision expiry with a reminder (Task 9); first notification channel = email (Task 8, plus Task 9 reminders). Four-eyes T3, AAL2 and delegation are deferred by decision and recorded in plan 0029 §13 item 18 (Task 1). D0 doc amendments: Task 1. D0 release (PR #17 merge, trust teardown) stays with the user.
- Exit criteria mapping: "every transition has a chained receipt verifiable by export" — Tasks 4, 5; "a requester cannot approve their own request" — Task 6; "an erasure request removes a snapshot without breaking the chain" — Task 7.

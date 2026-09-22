# Plan 0013 — One graph pagination contract, both adapters

**Date:** 2026-09-12 · **Status:** Implemented 2026-09-22 (M1 contract on `Repository.get_graph`; M2 `SupabaseRepository.get_graph` rewritten; M3's five cases in `apps/cloud/tests/contract/test_pagination.py` on plan 0020's `repo` fixture, **not** the standalone module M3 below proposes — plan 0020 built and reserved that landing place first). Two deviations from M2's suggested code, both forced by running the cases against a real local Supabase: the keyset predicate is pushed into SQL **exclusively** (a PostgREST `or=(...)` group) rather than as an inclusive `gte` refined afterwards, and the per-table over-fetch is `limit + 1` rather than `limit`. M2's code as written fails four of this plan's own five cases — see the M2 note below.

[Finding 3](../cloud-codebase-review-2026-09-06.md) of the cloud codebase review is the specification this plan implements: the two `Repository` adapters that back `GET /sync/projects/{project_id}/graph` implement different keyset-pagination semantics, and every pagination test in the suite runs against the in-memory adapter. The route itself is adapter-agnostic — `apps/cloud/app/api/sync.py:674-700` (`pull_graph`) just forwards `since`, `limit`, `after_ts`, and `after_id` to whichever `Repository` the app is wired to — so nothing at the API layer would catch the divergence; it is fully hidden inside `InMemoryRepository.get_graph` versus `SupabaseRepository.get_graph`. That makes this High severity per the review's own scale: it is incorrect behavior on a read path that desktop and web both depend on to keep their local task graphs complete, and it fails silently — a production client can believe it has drained a project's graph while rows were actually dropped.

## The divergence, precisely

**Ordering and candidate gathering.** `InMemoryRepository.get_graph` (`apps/cloud/app/db/repository.py:836-887`) builds one flat candidate list across every entity type before it ever limits:

```python
candidates: list[tuple[datetime, str, str, object]] = []
for etype in ENTITY_TYPES:
    for entity in store[etype].values():
        ...
        candidates.append((entity.updated_at, entity.id, etype, entity))

candidates.sort(key=lambda c: (c[0], c[1]))
truncated = limit is not None and len(candidates) > limit
if limit is not None:
    candidates = candidates[:limit]
```

The sort key is `(updated_at, id)` across `ENTITY_TYPES` globally (the six graph tables enumerated at `apps/cloud/app/models/schemas.py:515`: requirements, spec documents, tasks, artifacts, agent runs, discussions). One `limit` bounds the whole page regardless of how the returned rows split across those six types.

`SupabaseRepository.get_graph` (`apps/cloud/app/db/supabase_repository.py:557-595`) instead runs one query per entity type and applies `limit` to each query independently:

```python
for etype, model in ENTITY_TYPES.items():
    query = self._client.table(_TABLE[etype]).select("*").eq("project_id", project_id)
    ...
    query = query.order("updated_at").order("id")
    if limit is not None:
        query = query.limit(limit)
    res = query.execute()
    rows = [model(**row) for row in (res.data or [])]
```

A `limit=50` request against a project with 40 tasks and 40 requirements returns up to 50 of each — up to 300 rows across the six tables — not a 50-row page. The two adapters do not even agree on what `limit` counts.

**Where the limit is applied relative to the keyset filter.** In memory, the exclusive keyset predicate (`entity.updated_at < after_ts` skip, or `updated_at == after_ts and id <= after_id` skip) is applied while building `candidates`, strictly before the list is sorted and sliced to `limit`. In Supabase, the lower bound is only a `gte("updated_at", after_ts)` pushed into the SQL query (`apps/cloud/app/db/supabase_repository.py:579-580`) — an *inclusive* bound, because a `gt` would silently drop other rows that share `after_ts` exactly. The `limit` is applied by Postgres (`query.limit(limit)`) against that inclusive set, and only afterward does Python filter out the rows that were already returned:

```python
res = query.execute()
rows = [model(**row) for row in (res.data or [])]
if after_ts is not None and after_id is not None:
    rows = [
        r for r in rows if r.updated_at and (r.updated_at > after_ts or r.id > after_id)
    ]
```

This is the first concrete failure mode the review names: the database can hand back exactly `limit` rows for a table, every one of them sharing `after_ts` with an `id` at or below `after_id` (i.e. rows the client already has from the previous page), and the post-limit Python filter then discards all of them. The response for that table comes back empty even though unseen rows with the same `after_ts` — or a later `updated_at` — still exist. Nothing in the response distinguishes "this table is drained" from "the whole page was previously-seen rows filtered out after the fact."

**Continuation metadata.** In memory, `graph.next_id` and `graph.has_more` are set from the same `truncated`/`last` values computed off the merged, sorted, limited `candidates` list (`apps/cloud/app/db/repository.py:883-886`):

```python
graph.cursor = last[0] if last else (after_ts if after_ts else since)
if truncated and last:
    graph.next_id = last[1]
    graph.has_more = True
```

`SupabaseRepository.get_graph` never sets either field — `ProjectGraph.next_id` and `ProjectGraph.has_more` (`apps/cloud/app/models/schemas.py:590-604`) default to `None` and `False` and the Supabase method only ever assigns `graph.cursor`:

```python
graph.cursor = max_cursor
return graph
```

`max_cursor` is computed as the maximum `updated_at` seen across *all six tables' returned rows* (`apps/cloud/app/db/supabase_repository.py:591-593`), each of which was independently limited and then post-filtered. That is the second failure mode: a table with few or no changes can hold `max_cursor` down, or a table whose rows were entirely filtered out by the post-limit ID check contributes nothing to `max_cursor`, while another table's `max_cursor` legitimately advances further. A client that re-pulls with `since=cursor` on the next round trip has no way to know some tables still have unreturned rows at or before that cursor — `has_more` is always `False`, so nothing tells the client to keep paging, and rows are skipped permanently rather than merely delayed to the next page.

## Why the tests did not catch it

`apps/cloud/tests/conftest.py:15` pins every test in the suite to the in-memory backend before the app is even constructed:

```python
os.environ["DATA_BACKEND"] = "memory"
```

`test_graph_pull_keyset_pagination` (`apps/cloud/tests/test_sync.py:140-166`) exercises exactly the keyset loop this plan is about — it pages five tasks two at a time using `limit`, `after_ts`, and `after_id`, and asserts no dupes and no gaps — but because `conftest.py` never varies `DATA_BACKEND`, that assertion is only ever checked against `InMemoryRepository.get_graph`. `SupabaseRepository.get_graph` has no test coverage for pagination at all; the suite passing green (558 passed per the review's validation run) says nothing about the adapter that production actually runs. This is the general root cause the review flags, and the general fix — parametrising the whole cloud test suite over both repository backends — is out of scope here and belongs to `0020-repository-contract-suite.md`. This plan is narrower: it defines and implements the pagination contract itself, and adds the specific contract cases needed to prove that one contract, so the fix does not have to wait on the broader suite-wide harness.

## M1 — Write the contract down

Before touching either adapter, state the pagination contract as prose in one place so "correct" has a single definition both adapters (and any future adapter) are implementing against, not something inferred from whichever adapter a reader opens first. The natural home is a module docstring on `Repository.get_graph`'s abstract declaration in `apps/cloud/app/db/repository.py` (the abstract method sits above `class InMemoryRepository`, so both adapter implementations can point back to it), cross-referenced from `ProjectGraph`'s pagination fields at `apps/cloud/app/models/schemas.py:600-604`, which already carry a shorter version of this comment (`# Keyset continuation (M7): when a limit truncates the page, the client re-pulls with since=cursor & after_id=next_id.`) that this plan supersedes with the full contract. The statement must fix, unambiguously:

- **Ordering key**: candidate rows are ordered globally by `(updated_at, id)` across all six entity types in `ENTITY_TYPES`, not per table.
- **The exclusive keyset predicate**: given `after_ts`/`after_id`, a row is a candidate only if `updated_at > after_ts`, or `updated_at == after_ts and id > after_id`. This must be applied — in full, as an exclusive bound — before any row is counted against `limit`, exactly as memory already does at `apps/cloud/app/db/repository.py:860-867`, and never as an inclusive push-down filter refined afterward in application code.
- **What the limit counts**: `limit` bounds the total number of rows across all entity types in the page, not the count within any single table.
- **What the response reports**: `has_more` is `True` if and only if candidate rows existed beyond the page actually returned; when `True`, `next_id` and `cursor` together identify the exact keyset position (`after_ts=cursor`, `after_id=next_id`) a client must resend to get the next page with no gap and no duplicate.

## M2 — Make the production adapter implement it

`SupabaseRepository.get_graph` needs to fetch candidate rows from every table with the full exclusive predicate pushed into SQL, merge them globally in Python exactly the way memory already does, and only then limit and compute continuation metadata. The current per-table `query.limit(limit)` at `apps/cloud/app/db/supabase_repository.py:582-583` has to go — replaced by pulling up to `limit` rows *per table* (still bounded, so a project with far more entities than the page size doesn't pull unbounded rows per table) but treating that as an over-fetch to merge from, not the final page:

```python
def get_graph(
    self,
    project_id: str,
    since: datetime | None = None,
    limit: int | None = None,
    after_ts: datetime | None = None,
    after_id: str | None = None,
) -> ProjectGraph:
    project = self.get_project(project_id)
    if project is None:
        raise KeyError(project_id)
    graph = ProjectGraph(project=project)

    candidates: list[tuple[datetime, str, str, object]] = []
    for etype, model in ENTITY_TYPES.items():
        query = self._client.table(_TABLE[etype]).select("*").eq("project_id", project_id)
        if since is not None:
            query = query.gt("updated_at", since.isoformat())
        else:
            query = query.is_("deleted_at", "null")
        if after_ts is not None:
            # Inclusive push-down: the exclusive (updated_at, id) bound is
            # applied below, in the global merge, not here.
            query = query.gte("updated_at", after_ts.isoformat())
        query = query.order("updated_at").order("id")
        if limit is not None:
            query = query.limit(limit)  # over-fetch bound per table, not the page size
        res = query.execute()
        for row in res.data or []:
            entity = model(**row)
            if entity.updated_at is None:
                continue
            if after_ts is not None:
                if entity.updated_at < after_ts:
                    continue
                if entity.updated_at == after_ts and (
                    after_id is None or entity.id <= after_id
                ):
                    continue
            candidates.append((entity.updated_at, entity.id, etype, entity))

    candidates.sort(key=lambda c: (c[0], c[1]))
    truncated = limit is not None and len(candidates) > limit
    if limit is not None:
        candidates = candidates[:limit]

    rows_by_type: dict[str, list] = {etype: [] for etype in ENTITY_TYPES}
    last: tuple[datetime, str] | None = None
    for ts, eid, etype, entity in candidates:
        rows_by_type[etype].append(entity)
        last = (ts, eid)
    for etype in ENTITY_TYPES:
        setattr(graph, etype, rows_by_type[etype])

    graph.cursor = last[0] if last else (after_ts if after_ts else since)
    if truncated and last:
        graph.next_id = last[1]
        graph.has_more = True
    return graph
```

This mirrors `InMemoryRepository.get_graph`'s structure exactly: same exclusive predicate, same global sort key, same limit-after-merge, same `truncated`/`last`-derived continuation metadata (compare against `apps/cloud/app/db/repository.py:848-887`). The one structural difference from memory is unavoidable — Supabase still needs a per-table `query.limit(limit)` to avoid pulling every row in a table over the wire before merging — but that per-table fetch is now explicitly an over-fetch bound for building `candidates`, not the page itself; a table's own `limit` rows are always enough to guarantee correctness because `limit` (the page size) can never require more than `limit` rows from any single table to fill the merged page. `changes_head` (`apps/cloud/app/db/supabase_repository.py:597-626`) is unaffected — it never applies a `limit` to entity queries, so it does not share this bug — and is out of scope here. (Confirmed at implementation: `changes_head` was left untouched.)

**Correction, 2026-09-22, from running M3's cases against a local Supabase instance.** The code above is not sufficient, on its own terms, and the implementation deviates from it in two places. First, an inclusive `gte` push-down under a per-table fetch bound reproduces the very failure mode this plan names: the first `limit` rows a table returns can all sit at exactly `after_ts` with an `id` at or below `after_id`, the global merge then discards every one of them, and the page comes back empty while unseen rows wait directly behind them. Bounding the fetch does not rescue an inclusive bound — it is *what* makes the inclusive bound lossy — so the exclusive predicate goes into SQL in full, as a PostgREST `or=(updated_at.gt.T,and(updated_at.eq.T,id.gt.I))` group (with `after_id` double-quoted, because that group's commas and parentheses are grammar and `after_id` is client input). Second, the per-table bound must be `limit + 1`, not `limit`: with `limit` rows fetched from a table that holds more, the merged candidate list is exactly `limit` long, `len(candidates) > limit` is False, and `has_more` reports drained with rows left — which is the second failure mode restated, one layer down. One extra row per table is what distinguishes a full page from a drained one, and it is still enough, since a page can never need more than `limit` rows from any single table. With M2's code exactly as written above, four of the five M3 cases fail against Postgres (all but the mixed-entity-type one, which only checks what `limit` counts); with both deviations, all five pass on both adapters.

## M3 — Contract cases that run against both adapters

**Superseded in the detail, 2026-09-22:** plan 0020 landed first and built exactly this harness — a `repo` fixture parametrised over both adapters in `apps/cloud/tests/contract/conftest.py`, with the loud skip and the `PZ_CONTRACT_REQUIRE_SUPABASE=1` hard-fail described below — and reserved `apps/cloud/tests/contract/test_pagination.py` as the landing place for these cases. They live there, on that fixture; the standalone module and second fixture this paragraph proposes were not created, because two pagination harnesses is the duplication the review objected to in the first place. The cases themselves are unchanged from the list that follows.

The right shape for these tests is a small, focused new module — e.g. *apps/cloud/tests/test_graph_pagination_contract.py* (not yet created) — with a fixture parametrised over `["memory", "supabase"]` the way `test_graph_pull_keyset_pagination` currently exercises only the default backend at `apps/cloud/tests/test_sync.py:140`; each parametrised case should construct its own `Repository` instance directly (bypassing the FastAPI `client` fixture that `conftest.py:15` locks to `DATA_BACKEND=memory`) so it can exercise `SupabaseRepository` against a local/fake Postgres session, or be explicitly skipped with a clear reason when no such session is configured for a given CI run — never silently skip and report green. The cases the contract needs, each written once and run against both adapters via that parametrisation:

- **Equal timestamps spanning a page boundary.** Seed rows (e.g. tasks) sharing one `updated_at` value that outnumber `limit`; page through with the returned `cursor`/`next_id` and assert every row appears exactly once across pages, in `id` order among ties — this is the scenario the review's first failure mode targets directly (a page of previously-seen, same-timestamp rows must not come back empty).
- **Mixed entity types in one page.** Seed rows across at least two entity tables (e.g. requirements and tasks) with interleaved timestamps and a `limit` smaller than the combined count; assert the returned page is bounded by `limit` *in total*, not per table, and that the merge order matches the global `(updated_at, id)` ordering regardless of which table each row came from.
- **A page whose rows were all previously returned.** Directly reproduce the review's first failure mode: seed rows so that after paging to some `after_ts`/`after_id`, the next `limit`-sized slab a naive per-table query would return consists entirely of rows at or before that keyset position; assert the page instead skips straight to the next unseen rows rather than coming back empty with `has_more=False`.
- **More rows than the limit in a single table.** Seed one entity table alone with more rows than `limit` while other tables are empty or sparse; assert `has_more=True`, `next_id` matches the last returned row's id, and a follow-up pull with `after_ts=cursor, after_id=next_id` returns the remaining rows with no gap or duplicate — this is the review's second failure mode, phrased so a single table's `max_cursor` cannot silently advance past rows a merge would have included.
- **An exhausted cursor.** Page a small seeded set fully to completion and assert the final pull returns an empty page with `has_more=False` and (per the contract in M1) `next_id=None`, and that pulling again with the same final cursor is idempotent — no rows reappear, no error.

## Verification

From `apps/cloud`, with the venv active:

```bash
pytest tests/test_sync.py::test_graph_pull_keyset_pagination tests/contract/test_pagination.py -v
```

(As implemented: `tests/contract/test_pagination.py`, plan 0020's reserved landing place, rather than the new top-level module this section originally named.)

A reviewer should see `test_graph_pull_keyset_pagination` continue to pass unchanged (it only ever exercised memory, and this plan does not change memory's behavior), and every case in the new contract module pass once for each parametrised backend — so the same five scenarios above appear twice each in the pytest output, once per adapter, with matching pass/fail status. If the Supabase-parametrised cases are skipped in a given environment for lack of a database, the skip reason must name that explicitly (not report as passed), and a reviewer merging this plan's implementation should require at least one run where those cases executed against a real or locally-hosted Supabase/Postgres instance before accepting the fix — a green suite with the Supabase cases silently skipped reproduces exactly the blind spot this plan exists to close. A full `pytest -q` run from `apps/cloud` should otherwise show no new failures beyond the pre-existing DNS-dependent `test_probe_accepts_an_ordinary_public_host` the review already notes as an environment artifact, not a regression.

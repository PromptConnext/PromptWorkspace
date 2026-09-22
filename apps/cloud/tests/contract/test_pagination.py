"""Keyset pagination and continuation — owned by plan 0013, not by this file.

`docs/plans/0020-repository-contract-suite.md` M3 is explicit that this
invariant belongs to `docs/plans/0013-graph-pagination-contract.md`: that plan
defines what `limit` counts, where the keyset predicate is applied relative to
it, and what `has_more`/`next_id` must mean, and it supplies its own cases. This
plan's contribution is the harness those cases run on — the `repo` fixture in
`tests/contract/conftest.py`, already parametrised over both adapters.

So this module deliberately contains no tests. It is the named landing place:
plan 0013's parametrised module belongs here, taking `repo` as its fixture
rather than standing up a second harness of its own. Duplicating its cases here
would mean two pagination contracts to keep in agreement, which is the failure
mode the review found in the first place.

The divergence those cases have to pin down, for whoever picks that plan up:
`InMemoryRepository.get_graph` (app/db/repository.py:971) merges every entity
type into one list, sorts by `(updated_at, id)` and applies one `limit` to the
whole page, setting `has_more`/`next_id` when it truncates.
`SupabaseRepository.get_graph` (app/db/supabase_repository.py:653) issues one
query per entity type, applies `limit` to each independently, filters the
keyset continuation in Python *after* Postgres has already truncated, and never
sets `has_more` or `next_id` at all.
"""

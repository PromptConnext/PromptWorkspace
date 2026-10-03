"""A tracker link is keyed by account on either adapter (plan 0019).

The contract suite had no tracker coverage at all, and plan 0019 changes the
*key shape* of `pw_task_links` in both implementations at once — the in-memory
dict gains a third tuple element, the Supabase upsert gains a third `on_conflict`
column and a third `.eq()` filter. Those are two independent edits that a
memory-only test cannot tell apart from one: if the Supabase `on_conflict` list
had been left at two columns, every case in `tests/test_tracker_account_identity
.py` would still pass while the real table silently merged two tenants' `PZ-1`
into one row. Stating it here runs it against both.

`pw_workspace_integrations` is in the same file for the same reason: its unique
`(provider, account_key)` constraint is the mechanism of the whole plan, and the
two adapters enforce it by different means — the migration's constraint on one
side, an explicit scan on the other — so "two workspaces cannot claim one Jira
site" has to be asserted as a contract rather than as a detail of either.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository, TrackerAccountConflict
from app.models.schemas import Task, TaskLink, WorkspaceIntegration, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract

SITE_A = "https://contract-a.atlassian.net"
SITE_B = "https://contract-b.atlassian.net"


def _linked_task(repo: Repository) -> tuple[str, str]:
    """A workspace's project with one task in it. Returns (project_id, task_id)."""
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    task_id = new_id()
    h.push_tasks(repo, project.id, [Task(id=task_id, project_id=project.id, title="mirror me")])
    return project.id, task_id


def test_the_same_issue_key_on_two_accounts_is_two_links(repo: Repository) -> None:
    """The defect, stated as a contract. Both tenants run a project keyed PZ, so
    both produce `PZ-1`; under the old `(provider, external_key)` key the second
    upsert overwrote the first and either site's webhook then reached one task."""
    project_a, task_a = _linked_task(repo)
    project_b, task_b = _linked_task(repo)

    repo.upsert_task_link(
        TaskLink(
            task_id=task_a,
            project_id=project_a,
            provider="jira",
            account_key=SITE_A,
            external_key="PZ-1",
        )
    )
    repo.upsert_task_link(
        TaskLink(
            task_id=task_b,
            project_id=project_b,
            provider="jira",
            account_key=SITE_B,
            external_key="PZ-1",
        )
    )

    resolved_a = repo.find_task_link_by_key("jira", SITE_A, "PZ-1")
    resolved_b = repo.find_task_link_by_key("jira", SITE_B, "PZ-1")
    assert resolved_a is not None and resolved_b is not None
    assert (resolved_a.project_id, resolved_a.task_id) == (project_a, task_a)
    assert (resolved_b.project_id, resolved_b.task_id) == (project_b, task_b)

    # A third site holds no claim on that key at all.
    assert repo.find_task_link_by_key("jira", "https://contract-c.atlassian.net", "PZ-1") is None
    # And neither does the pre-0032 backfill value.
    assert repo.find_task_link_by_key("jira", "", "PZ-1") is None


def test_re_upserting_the_same_triple_updates_in_place(repo: Repository) -> None:
    """The third key column must not cost idempotence: a re-delivery of the same
    (provider, account_key, external_key) is still one link, not two."""
    project_id, task_id = _linked_task(repo)
    for url in ("first", "second"):
        repo.upsert_task_link(
            TaskLink(
                task_id=task_id,
                project_id=project_id,
                provider="jira",
                account_key=SITE_A,
                external_key="PZ-7",
                external_url=url,
            )
        )
    resolved = repo.find_task_link_by_key("jira", SITE_A, "PZ-7")
    assert resolved is not None
    assert resolved.external_url == "second"
    # get_task_link is the route's idempotency check (plan 0019 M3) and must see
    # the same single link.
    by_task = repo.get_task_link(task_id, "jira")
    assert by_task is not None
    assert (by_task.external_key, by_task.account_key) == ("PZ-7", SITE_A)


def test_an_account_binds_to_exactly_one_workspace(repo: Repository) -> None:
    ws_one, _ = h.workspace(repo)
    ws_two, _ = h.workspace(repo)
    site = f"https://contract-{new_id()[:8]}.atlassian.net"

    repo.upsert_workspace_integration(
        WorkspaceIntegration(
            workspace_id=ws_one.id,
            provider="jira",
            account_key=site,
            webhook_secret_ref="ciphertext-one",
        )
    )
    with pytest.raises(TrackerAccountConflict):
        repo.upsert_workspace_integration(
            WorkspaceIntegration(
                workspace_id=ws_two.id,
                provider="jira",
                account_key=site,
                webhook_secret_ref="ciphertext-two",
            )
        )

    found = repo.find_workspace_integration_by_account("jira", site)
    assert found is not None
    assert found.workspace_id == ws_one.id
    assert found.webhook_secret_ref == "ciphertext-one"


def test_rebinding_the_same_workspace_to_the_same_account_is_not_a_conflict(
    repo: Repository,
) -> None:
    """Re-saving a workspace's own settings must not look like a second claimant
    — `configure_integration` upserts on every save."""
    ws, _ = h.workspace(repo)
    site = f"https://contract-{new_id()[:8]}.atlassian.net"
    for ref in ("ciphertext-one", "ciphertext-two"):
        repo.upsert_workspace_integration(
            WorkspaceIntegration(
                workspace_id=ws.id,
                provider="jira",
                account_key=site,
                webhook_secret_ref=ref,
            )
        )
    stored = repo.get_workspace_integration(ws.id, "jira")
    assert stored is not None
    assert stored.webhook_secret_ref == "ciphertext-two"


def test_an_unconfigured_account_resolves_to_nothing(repo: Repository) -> None:
    """What the webhook route's first step depends on: an unrecognized account
    has no row, so the delivery is refused before its payload is trusted. The
    empty-string case is explicit because `''` is the pre-0032 backfill value on
    `pw_task_links.account_key` and must never resolve."""
    unknown = repo.find_workspace_integration_by_account("jira", "https://nobody.atlassian.net")
    assert unknown is None
    assert repo.find_workspace_integration_by_account("jira", "") is None
    ws, _ = h.workspace(repo)
    assert repo.get_workspace_integration(ws.id, "jira") is None

from datetime import datetime, timedelta, timezone

from app.models.schemas import (
    Decision,
    PolicyScope,
    Project,
    ProjectRole,
    RepoAnalysis,
    RepoSnapshot,
    RepoStack,
    TaskStatus,
    TaskSummary,
    WorkspaceGovernance,
)
from app.overview.cards import build_card
from app.overview.checks import run_checks

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)
WS = "w1"


def _project(**kw) -> Project:
    kw.setdefault("updated_at", NOW - timedelta(days=5))
    return Project(id="p1", name="P", workspace_id=WS, owner_id="u0", **kw)


def _task(
    i, status=TaskStatus.todo, user=None, closed=False, days=1, closed_days=None
) -> TaskSummary:
    if closed_days is None:
        closed_days = days
    return TaskSummary(
        task_id=f"t{i}",
        project_id="p1",
        status=status,
        assigned_user_id=user,
        agent_closed=closed,
        agent_closed_at=NOW - timedelta(days=closed_days) if closed else None,
        updated_at=NOW - timedelta(days=days),
    )


def _role(hat, user="u1") -> ProjectRole:
    return ProjectRole(project_id="p1", workspace_id=WS, hat=hat, user_id=user, assigned_by="a")


def _decision(status="open", expires=None, resolved=None) -> Decision:
    return Decision(
        project_id="p1",
        workspace_id=WS,
        kind="intent_approval",
        title="d",
        subject_stage="specify",
        subject_hash="h",
        routed_hat="business_owner",
        requested_by="u0",
        status=status,
        expires_at=expires,
        resolved_at=resolved,
    )


def _gov(**kw) -> WorkspaceGovernance:
    return WorkspaceGovernance(workspace_id=WS, **kw)


def _card(project=None, roles=(), tasks=(), decisions=(), analysis=None, gov=None, receipt=None):
    return build_card(
        project or _project(), list(roles), list(tasks), list(decisions), analysis,
        gov or WorkspaceGovernance.default(WS), receipt, NOW,
    )


def _analysis(languages) -> RepoAnalysis:
    snap = RepoSnapshot.model_construct(
        stack=RepoStack(runtime="python", manifests=["pyproject.toml"], languages=languages)
    )
    return RepoAnalysis.model_construct(project_id="p1", snapshot=snap)


def test_card_counts_tasks_by_status():
    card = _card(tasks=[_task(1), _task(2, TaskStatus.verified), _task(3, TaskStatus.todo)])
    assert card.task_counts == {"todo": 2, "in_progress": 0, "implemented": 0, "verified": 1}


def test_contributors_distinct_most_tasks_first():
    tasks = [_task(1, user="b"), _task(2, user="a"), _task(3, user="c"), _task(4, user="c"),
             _task(5)]
    assert _card(tasks=tasks).contributors == ["c", "a", "b"]


def test_stack_from_analysis_runtime_and_three_languages():
    card = _card(analysis=_analysis(["py", "ts", "go", "rs"]))
    assert card.stack == {"runtime": "python", "languages": ["py", "ts", "go"]}


def test_stack_none_without_analysis():
    assert _card().stack is None


def test_decisions_open_overdue_expired_30d():
    ds = [
        _decision("open", expires=NOW - timedelta(days=1)),
        _decision("open", expires=NOW + timedelta(days=1)),
        _decision("expired", expires=NOW - timedelta(days=10), resolved=NOW - timedelta(days=10)),
        _decision("expired", expires=NOW - timedelta(days=40), resolved=NOW - timedelta(days=40)),
    ]
    assert _card(decisions=ds).decisions == {"open": 2, "overdue": 1, "expired_30d": 1}


def test_last_activity_is_max_of_project_tasks_receipt():
    p = _project(updated_at=NOW - timedelta(days=9))
    t = [_task(1, days=3)]
    assert _card(p, tasks=t).last_activity_at == NOW - timedelta(days=3)
    r = NOW - timedelta(hours=1)
    assert _card(p, tasks=t, receipt=r).last_activity_at == r
    assert _card(p).last_activity_at == p.updated_at


def test_agent_closed_30d():
    tasks = [_task(1, closed=True, days=2), _task(2, closed=True, days=40), _task(3)]
    assert _card(tasks=tasks).agent_closed_30d == 1


def test_agent_closed_30d_windows_on_the_close_not_the_edit():
    # edited today, but the agent closed it 40 days ago
    tasks = [_task(1, closed=True, days=0, closed_days=40)]
    assert _card(tasks=tasks).agent_closed_30d == 0


def test_live_url_and_policy_source():
    from app.models.schemas import DeploymentState

    p = _project(
        deployment_state=DeploymentState(state="live", url="https://x"),
        policy_scope=PolicyScope(selected=["a"]),
    )
    card = _card(p)
    assert card.live_url == "https://x"
    assert card.policy == {"source": "project", "selected": ["a"], "require_seeded_rules": True}
    off = _card(p, gov=_gov(require_seeded_rules=False))
    assert off.policy["require_seeded_rules"] is False
    p2 = _project(deployment_state=DeploymentState(state="failed", url="https://x"))
    assert _card(p2).live_url is None


def test_checks_order_and_sentences():
    p = _project(policy_scope=PolicyScope(selected=["a"]))
    gov = _gov(policy_scope=PolicyScope(selected=["b"]))
    checks = run_checks(p, [_role("business_owner")], [], gov, NOW)
    assert [c.id for c in checks] == [
        "hat_business_owner", "hat_tech_steward", "policy_matches_workspace", "decisions_overdue",
    ]
    failing = [c for c in checks if not c.ok]
    assert failing[0].id == "hat_tech_steward"
    assert failing[0].text == "No tech steward assigned"
    assert failing[1].text == "Policy scope differs from the workspace"


def test_business_owner_sentence_and_overdue_plurals():
    one = [_decision("open", expires=NOW - timedelta(days=1))]
    two = one + [_decision("expired", expires=NOW - timedelta(days=3), resolved=NOW)]
    gov = _gov()
    c1 = run_checks(_project(), [], one, gov, NOW)
    assert c1[0].text == "No business owner assigned"
    assert c1[-1] == c1[-1].model_copy(update={"ok": False, "text": "1 decision past its due date"})
    c2 = run_checks(_project(), [], two, gov, NOW)
    assert c2[-1].text == "2 decisions past their due date"


def test_policy_check_skipped_when_workspace_scope_empty():
    p = _project(policy_scope=PolicyScope(selected=["a"]))
    ids = [c.id for c in run_checks(p, [], [], _gov(), NOW)]
    assert "policy_matches_workspace" not in ids
    assert "policy_empty" not in ids


def test_policy_empty_when_both_empty():
    checks = run_checks(_project(), [], [], _gov(), NOW)
    empty = [c for c in checks if c.id == "policy_empty"]
    assert len(empty) == 1 and not empty[0].ok and empty[0].text == "No policy scope set"


def test_policy_matches_as_sets():
    p = _project(policy_scope=PolicyScope(selected=["b", "a"]))
    gov = _gov(policy_scope=PolicyScope(selected=["a", "b"]))
    c = [x for x in run_checks(p, [], [], gov, NOW) if x.id == "policy_matches_workspace"]
    assert c[0].ok


def test_required_hats_respected():
    checks = run_checks(_project(), [], [], _gov(required_hats=["tech_steward"]), NOW)
    ids = [c.id for c in checks]
    assert "hat_business_owner" not in ids and "hat_tech_steward" in ids


def test_hat_checks_follow_spec_order_whatever_the_stored_order():
    gov = _gov(required_hats=["tech_steward", "business_owner"])
    ids = [c.id for c in run_checks(_project(), [], [], gov, NOW) if c.id.startswith("hat_")]
    assert ids == ["hat_business_owner", "hat_tech_steward"]

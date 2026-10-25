"""Structural guard: an RPC on the caller's scoped client must be granted to
`authenticated`.

`SupabaseRepository._client` carries the caller's JWT in per-user repositories;
`_service_client` is the service-role client. Functions granted to
`service_role` only (e.g. pw_latest_receipt_at, pw_freeze_deployment_tasks)
fail with SQLSTATE 42501 on the scoped client, and the contract suite (service
key) cannot notice. Any new scoped rpc call must be added to the allowlist
deliberately.
"""

from __future__ import annotations

import ast
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "app" / "db" / "supabase_repository.py"

# The two match-chunks functions carry `grant execute on function
# pw_rag_match_chunks(...)` / `pw_code_match_chunks(...)` `to authenticated`
# in migrations/0002_pw_baseline.sql, so they stay on the scoped client.
_GRANTED_TO_AUTHENTICATED = {"_RAG_MATCH_RPC", "_CODE_MATCH_RPC"}


def test_scoped_rpc_calls_are_only_for_functions_granted_to_authenticated():
    tree = ast.parse(_SRC.read_text())
    offenders: list[str] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr != "rpc":
            continue
        target = node.func.value
        if not (
            isinstance(target, ast.Attribute)
            and target.attr == "_client"
            and isinstance(target.value, ast.Name)
            and target.value.id == "self"
        ):
            continue
        first = node.args[0] if node.args else None
        name = ast.unparse(first) if first is not None else "<none>"
        if name not in _GRANTED_TO_AUTHENTICATED:
            offenders.append(f"line {node.lineno}: {name}")
    assert not offenders, (
        "self._client.rpc on a function not granted to authenticated "
        f"(use self._service_client): {offenders}"
    )

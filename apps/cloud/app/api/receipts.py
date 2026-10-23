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

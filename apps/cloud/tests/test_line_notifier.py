import base64
import hashlib
import hmac
import time
from concurrent.futures import ThreadPoolExecutor

from app.db.repository import InMemoryRepository
from app.integrations.line import LineNotifier, RecordingLineClient, verify_signature
from app.models.schemas import ProjectLineLink, utcnow


def _linked_repo(language: str = "en"):
    repo = InMemoryRepository()
    ws = repo.create_workspace("W", "u1")
    repo.update_workspace(ws.id, language=language)
    project = repo.create_project(ws.id, "u1", "P")
    return repo, project


def _link(repo, project_id: str, group_id: str = "C123") -> None:
    repo.set_project_line_link(
        ProjectLineLink(
            project_id=project_id, group_id=group_id, linked_by="u1", linked_at=utcnow()
        )
    )


def test_verify_signature_accepts_good_rejects_bad_and_missing():
    body = b'{"events": []}'
    good = base64.b64encode(hmac.new(b"s3cret", body, hashlib.sha256).digest()).decode()
    assert verify_signature("s3cret", body, good)
    assert not verify_signature("s3cret", body, good[:-2] + "xx")
    assert not verify_signature("other", body, good)
    assert not verify_signature("s3cret", body + b" ", good)
    assert not verify_signature("s3cret", body, None)
    assert not verify_signature("s3cret", body, "")


def test_notifier_pushes_built_text_to_linked_group_in_workspace_language():
    repo, project = _linked_repo("th")
    _link(repo, project.id)
    client = RecordingLineClient()
    executor = ThreadPoolExecutor(max_workers=1)
    seen: list[str] = []

    def build(language: str) -> str:
        seen.append(language)
        return f"text-{language}"

    LineNotifier(client, repo, executor).notify_project(project.id, build)
    executor.shutdown(wait=True)
    assert seen == ["th"]
    assert client.pushed == [("C123", "text-th")]


def test_notifier_does_nothing_when_unlinked_or_disabled():
    repo, project = _linked_repo()
    client = RecordingLineClient()
    executor = ThreadPoolExecutor(max_workers=1)
    LineNotifier(client, repo, executor).notify_project(project.id, lambda _l: "x")
    _link(repo, project.id)
    disabled = LineNotifier(None, repo, executor)
    assert disabled.enabled is False
    disabled.notify_project(project.id, lambda _l: "x")
    executor.shutdown(wait=True)
    assert client.pushed == []


def test_notifier_returns_before_the_client_finishes():
    repo, project = _linked_repo()
    _link(repo, project.id)
    client = RecordingLineClient(delay=1.0)
    executor = ThreadPoolExecutor(max_workers=1)
    started = time.monotonic()
    LineNotifier(client, repo, executor).notify_project(project.id, lambda _l: "hi")
    assert time.monotonic() - started < 0.1
    assert client.pushed == []
    executor.shutdown(wait=True)
    assert client.pushed == [("C123", "hi")]


def test_notifier_swallows_client_errors():
    repo, project = _linked_repo()
    _link(repo, project.id)

    class Boom(RecordingLineClient):
        def push(self, to: str, text: str) -> None:
            raise RuntimeError("line down")

    executor = ThreadPoolExecutor(max_workers=1)
    LineNotifier(Boom(), repo, executor).notify_project(project.id, lambda _l: "x")
    executor.shutdown(wait=True)

    def bad_build(_language: str) -> str:
        raise ValueError("bad template")

    executor = ThreadPoolExecutor(max_workers=1)
    LineNotifier(RecordingLineClient(), repo, executor).notify_project(project.id, bad_build)
    executor.shutdown(wait=True)

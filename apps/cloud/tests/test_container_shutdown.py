"""The container stops without killing the requests it is serving (trust test
finding #13: a deploy cut a running "Generate rules" stream).

A rolling deploy sends the old instance SIGTERM once the new one is ready.
uvicorn then stops accepting connections and lets the requests in flight
finish, for at most `--timeout-graceful-shutdown` seconds — but only if the
signal reaches it, which needs uvicorn to *be* the container's main process
(`exec`), not a child of the shell that started it. The platform's own grace
period (docs/DEPLOYMENT.md) must outlast uvicorn's, or the instance is killed
mid-drain.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

CLOUD = Path(__file__).resolve().parents[1]
DOCKERFILE = CLOUD / "Dockerfile"
DEPLOYMENT_DOC = CLOUD.parents[1] / "docs" / "DEPLOYMENT.md"


def _command() -> list[str]:
    """The uvicorn command line the image runs, as argv."""
    (cmd,) = [line for line in DOCKERFILE.read_text().splitlines() if line.startswith("CMD ")]
    argv = json.loads(cmd.removeprefix("CMD "))
    assert argv[:2] == ["sh", "-c"], argv  # the shell expands ${PORT}
    return shlex.split(argv[2])


def _graceful_timeout() -> int:
    argv = _command()
    return int(argv[argv.index("--timeout-graceful-shutdown") + 1])


def test_uvicorn_replaces_the_shell_so_it_receives_sigterm():
    argv = _command()
    assert argv[:2] == ["exec", "uvicorn"], argv


def test_in_flight_requests_get_thirty_seconds_to_finish():
    assert _graceful_timeout() == 30


def test_the_documented_platform_grace_period_outlasts_uvicorns():
    doc = DEPLOYMENT_DOC.read_text()
    match = re.search(r"termination grace period[^\n]*?(\d+)\s*s", doc, re.IGNORECASE)
    assert match, "docs/DEPLOYMENT.md names no termination grace period"
    assert int(match.group(1)) >= _graceful_timeout() + 5


SLOW_APP = '''
import asyncio


async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"text/plain")]})
    if scope["path"] == "/stream":
        # A stand-in for a generation stream: chunks over two seconds.
        for i in range(4):
            await asyncio.sleep(0.5)
            await send({"type": "http.response.body", "body": f"chunk{i} ".encode(),
                        "more_body": True})
    await send({"type": "http.response.body", "body": b"done"})
'''


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_sigterm_lets_a_stream_in_flight_finish(tmp_path):
    """The image's command, pointed at a stand-in app, stops on SIGTERM only
    after a stream already in flight has finished. A behaviour check of the
    whole command rather than a regression test: macOS's `sh` already execs a
    lone `-c` command, so the old command passes here too; the two checks
    above pin the parts that differ."""
    (tmp_path / "slowapp.py").write_text(SLOW_APP)
    port = _free_port()
    argv = [
        "slowapp:app" if arg == "app.main:app" else arg.replace("0.0.0.0", "127.0.0.1")
        for arg in _command()
    ]
    env = {**os.environ, "PORT": str(port),
           "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
    # Its own process group, so cleanup reaches a uvicorn the shell left behind.
    proc = subprocess.Popen(["sh", "-c", " ".join(argv)], cwd=tmp_path, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).read()
                break
            except OSError:
                assert time.monotonic() < deadline, "uvicorn did not start"
                time.sleep(0.1)

        body: list[bytes] = []
        reader = threading.Thread(target=lambda: body.append(
            urllib.request.urlopen(f"http://127.0.0.1:{port}/stream", timeout=10).read()))
        reader.start()
        time.sleep(0.6)  # the stream is under way
        proc.send_signal(signal.SIGTERM)  # what the platform sends the old instance
        reader.join(timeout=10)

        assert body == [b"chunk0 chunk1 chunk2 chunk3 done"]
        # uvicorn exits once drained (re-raising the signal it caught), and
        # nothing is left serving: with a shell in between, the shell died at
        # once and an orphaned uvicorn went on listening, out of reach.
        assert proc.wait(timeout=10) in (0, -signal.SIGTERM)
        with socket.socket() as s, pytest.raises(ConnectionRefusedError):
            s.connect(("127.0.0.1", port))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()

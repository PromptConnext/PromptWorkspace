"""Minimal Python service. Replace it with your application — the pipeline
around it (Dockerfile, compose.yaml, .github/workflows/deploy.yml) is what
PromptWorkspace seeded, and it does not care what this file grows into.

Standard library only, so the seeded image builds before this project has
picked a framework.
"""

import http.server
import os
import pathlib

PORT = int(os.environ.get("PORT", "8080"))
# Passed in by compose from the deploy workflow. Naming the PromptWorkspace web
# origin as a frame ancestor is what lets the project's Preview tab embed this
# app instead of falling back to a link card.
WEB_ORIGIN = os.environ.get("PROMPTWORKSPACE_WEB_ORIGIN", "")

PUBLIC = pathlib.Path.cwd() / "public"
TYPES = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - name fixed by the base class
        if self.path == "/healthz":
            self._send(200, "text/plain", b"ok")
            return

        rel = "index.html" if self.path == "/" else self.path.split("?")[0].lstrip("/")
        target = (PUBLIC / rel).resolve()
        # Re-checked against the public root rather than trusted: the path came
        # off the wire, and `..` escaping it would serve any file in the image.
        if not target.is_relative_to(PUBLIC.resolve()) or not target.is_file():
            self._send(404, "text/plain", b"not found")
            return
        self._send(200, TYPES.get(target.suffix, "application/octet-stream"), target.read_bytes())

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        if WEB_ORIGIN:
            self.send_header("content-security-policy", f"frame-ancestors {WEB_ORIGIN}")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        # Default goes to stderr with a timestamp the container runtime already
        # adds. Kept, but quieted to one line.
        print(fmt % args, flush=True)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

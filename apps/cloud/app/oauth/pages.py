"""Static HTML for `GET /oauth/authorize` errors that must not redirect.

Before the client and its `redirect_uri` are validated there is nowhere safe
to send the browser (RFC 6749 §4.1.2.1), so the user sees this page instead.
Only fixed error codes are rendered; nothing from the request is echoed."""

from __future__ import annotations

from html import escape

from fastapi.responses import HTMLResponse

_TEMPLATE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorization error</title></head>
<body>
<h1>Authorization error</h1>
<p>{sentence}</p>
<p><code>{code}</code></p>
</body>
</html>
"""

_SENTENCES = {
    "invalid_client": "The application asking for access is not recognised.",
    "invalid_redirect_uri": "The application's return address is not one it registered.",
}


def error_page(code: str) -> HTMLResponse:
    sentence = _SENTENCES.get(code, "The authorization request is not valid.")
    body = _TEMPLATE.format(sentence=escape(sentence), code=escape(code))
    return HTMLResponse(body, status_code=400, headers={"Cache-Control": "no-store"})

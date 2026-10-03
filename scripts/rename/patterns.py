"""Single source of truth for the PromptConnext -> PromptWorkspace token map.

Shared by ``rename.py`` (applies the map) and ``check.py`` (the CI grep gate),
so the gate searches for exactly the left-hand sides the map rewrites.

The map runs in three steps over a file's whole text:

1. **Mask** protected spans (company name, GitHub org, domains, the
   Marketplace publisher and the new extension ID) with placeholders, by token
   span -- never by whole line. Every mask that ends in a name carries a right
   boundary, so ``promptconnext.commitScanLimit`` is not mistaken for the
   ``promptconnext.com`` domain.
2. **One compiled alternation** applied with a single ``re.sub(callback)``, so
   each match is replaced exactly once (no cascading).
3. **Unmask.**
"""

from __future__ import annotations

import re

# Right boundary used after names: the next char may not extend the token.
_RB = r"(?![A-Za-z0-9-])"

# Spans that keep "PromptConnext" (the company) or are externally fixed.
PROTECTED: list[str] = [
    r"github\.com/PromptConnext/",
    r"git@github\.com:PromptConnext/",
    # The GitHub org written bare before one of its repo names.
    r"PromptConnext/(?=(?:PromptWorkspace|promptconnext-corp-web|promptconnext-projects)" + _RB + r")",
    r"promptconnext-corp-web" + _RB,
    r"promptconnext-projects" + _RB,
    r'"publisher": "promptconnext"',
    r"promptconnext\.promptworkspace" + _RB,
    r"com\.promptconnext\.(?=promptworkspace" + _RB + r")",
    r"no-reply@promptconnext\.com" + _RB,
    r"promptconnext\.truthledgers\.com" + _RB,
    r"promptconnext\.com" + _RB,
    # Company / copyright spans.
    r"©\s*\d{4}(?:[–-]\d{4})?\s+PromptConnext",
    r"Copyright \(c\) \d{4}(?:[–-]\d{4})? PromptConnext",
    r"PromptConnext Co\.",
    # Only the company verbs: "seeded by PromptConnext Cloud" names the product.
    r"(?:hosted|managed|minted|supplied|built|made|operated)\s+by\s+PromptConnext"
    r"(?!\s+(?:Cloud|Workspace|Desktop|MCP|extension))",
    r"PromptConnext company",
    r"PromptConnext is the company",
    r"permission from PromptConnext",
    # apps/cloud/scripts/migrate.py names the pre-baseline table prefix once,
    # to refuse a database that still has the old ledger.
    r'PRE_BASELINE_TABLE_PREFIX = "pz_"',
    # Dated historical docs keep their file names (D3), so links to them do too.
    r"promptzone-(?:design-system-plan|diagrams|platform-architecture|product-roadmap)\.md",
    r"promptzone-graph\.png",
]

# (pattern, replacement). Order is priority: at any position the first
# alternative that matches wins, so longer / more specific tokens come first.
MAPPING: list[tuple[str, str]] = [
    (r"PROMPTCONNEXT_", "PROMPTWORKSPACE_"),
    (r"PROMPTZONE_", "PROMPTWORKSPACE_"),
    (r"(?<![A-Za-z0-9])PZ_", "PROMPTWORKSPACE_"),
    (r"promptconnext\.promptconnext-vscode", "promptconnext.promptworkspace"),
    (r"promptconnext-vscode", "promptworkspace"),
    (r"promptconnext-mcp", "promptworkspace-mcp"),
    (r"promptconnext://", "promptworkspace://"),
    (r"dev\.ideva\.promptconnext", "com.promptconnext.promptworkspace"),
    (r"@promptconnext/pz-cloud", "@promptworkspace/cloud-client"),
    (r"@promptconnext/", "@promptworkspace/"),
    (r"pz-cloud", "cloud-client"),
    (r"pz_cloud", "cloud_client"),
    (r"pz-documents", "pw-documents"),
    (r"pz-preview", "pw-preview"),
    (r"_pz_", "_pw_"),
    (r"(?<![A-Za-z0-9])pz_", "pw_"),
    (r"PromptZone", "PromptWorkspace"),
    (r"promptzone", "promptworkspace"),
    (r"PromptConnext", "PromptWorkspace"),
    (r"promptconnext", "promptworkspace"),
    (r"PROMPTCONNEXT", "PROMPTWORKSPACE"),
    (r"PROMPTZONE", "PROMPTWORKSPACE"),
    # Any other casing; the replacement keeps the source's case style.
    (r"(?i:promptconnext|promptzone)", None),  # type: ignore[list-item]
]

PROTECTED_RE = re.compile("|".join(f"(?:{p})" for p in PROTECTED))
MAP_RE = re.compile("|".join(f"({p})" for p, _ in MAPPING))

# Placeholders use private-use code points that never occur in source text.
_MASK_OPEN, _MASK_CLOSE = "\ue000", "\ue001"
_MASK_RE = re.compile(f"{_MASK_OPEN}(\\d+){_MASK_CLOSE}")


def _case_like(src: str) -> str:
    if src.isupper():
        return "PROMPTWORKSPACE"
    if src[:1].isupper():
        return "Promptworkspace"
    return "promptworkspace"


def _replace(m: re.Match[str]) -> str:
    idx = m.lastindex - 1  # exactly one top-level group participates
    repl = MAPPING[idx][1]
    return _case_like(m.group(0)) if repl is None else repl


def mask(text: str) -> tuple[str, list[str]]:
    saved: list[str] = []

    def _save(m: re.Match[str]) -> str:
        saved.append(m.group(0))
        return f"{_MASK_OPEN}{len(saved) - 1}{_MASK_CLOSE}"

    return PROTECTED_RE.sub(_save, text), saved


def unmask(text: str, saved: list[str]) -> str:
    return _MASK_RE.sub(lambda m: saved[int(m.group(1))], text)


def rename_text(text: str) -> str:
    masked, saved = mask(text)
    return unmask(MAP_RE.sub(_replace, masked), saved)


def residual_hits(text: str, allowlist: re.Pattern[str] | None = None) -> list[tuple[int, str]]:
    """Return ``(line_no, token)`` for every map left-hand side still present.

    Allowlisted spans are blanked out (same length, so line numbers hold)
    before searching, so a line holding both an allowed span and a stray
    token still reports the stray token.
    """
    scrubbed = text
    if allowlist is not None:
        scrubbed = allowlist.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    return [(scrubbed.count("\n", 0, m.start()) + 1, m.group(0)) for m in MAP_RE.finditer(scrubbed)]

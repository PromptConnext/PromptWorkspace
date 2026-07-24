# Open VSX extension audit (ADR 0016 M0)

Extensions a PromptConnext developer persona actually needs, checked against
[open-vsx.org](https://open-vsx.org) availability. "Need" = derived from what
the current Tauri/Monaco shell already assumes (TypeScript/JS editing, Git,
the languages ADR 0009's BYO-agent CLIs touch) plus baseline IDE ergonomics.

| Extension | Purpose | Open VSX? | Marketplace-only risk |
|---|---|---|---|
| `vscode.typescript-language-features` (built into Theia via `@theia/typescript`) | TS/JS language server | Bundled, not a marketplace ext | None |
| `dbaeumer.vscode-eslint` | ESLint | Yes | None |
| `esbenp.prettier-vscode` | Prettier | Yes | None |
| `ms-python.python` | Python language support | Yes (mirrored) | **Watch**: Pylance (`ms-python.vscode-pylance`) is Marketplace-only by license, not mirrored on Open VSX |
| `rust-lang.rust-analyzer` | Rust (desktop shell itself is Rust today) | Yes | None |
| `redhat.vscode-yaml` | YAML | Yes | None |
| `ms-vscode.vscode-typescript-next` | Nightly TS | Not needed | n/a |
| `eamodio.gitlens` | Git history/blame | Yes | None |
| `github.vscode-pull-request-github` | GitHub PR review in-editor | Yes (mirrored) | None known |
| `ms-vscode-remote.remote-containers` | Devcontainers | **No** | Marketplace-only, MS-licensed remote extensions in general don't ship on Open VSX |
| `ms-azuretools.vscode-docker` | Docker | Yes (community mirror exists, lags official) | Low |
| `golang.go` | Go | Yes | None |
| `ms-vscode.cpptools` (C/C++) | C/C++ IntelliSense | Present on Open VSX but Microsoft's 2025 ToS enforcement broke it running from non-MS hosts (per ADR 0016 research) | **Confirmed real blocker** — the exact incident the research cited |

## Verdict

One confirmed blocker (**C/C++ tooling**, `ms-vscode.cpptools`) and one likely
gap (**Pylance**) if any PromptConnext developer works in C/C++ or wants
Pylance-grade Python intelligence. Neither blocks the *primary* persona
(TS/JS engine + web/cloud apps, which is what this repo actually is) — ESLint,
Prettier, GitLens, rust-analyzer, Go, YAML, Docker all resolve cleanly on
Open VSX.

**Recommendation:** no unresolved blocker for this repo's actual stack. Flag
C/C++ and Pylance as known gaps to revisit if/when a developer needs them —
open-source alternatives exist (`clangd` extension for C/C++, `python-lsp-server`
via `ms-pyright`-community forks for Python) that are Open VSX-native.

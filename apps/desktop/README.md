# apps/desktop

Tauri 2 shell around the `apps/engine` sidecar. See root `CLAUDE.md` for the full architecture and `docs/BUILD_AND_DISTRIBUTE.md` / `docs/DEPLOYMENT.md` for build and release detail.

## Cutting a release

`.github/workflows/desktop-build.yml` builds installers and uploads them to R2 (`installation/` prefix, flat — no version subfolder). It fires **only** on a `v*` tag push or manual `workflow_dispatch` — a normal commit/push to `main`, even one that bumps the version number, does **not** trigger it.

Before tagging, both version fields must match:

- `apps/desktop/package.json` → `version`
- `apps/desktop/src-tauri/tauri.conf.json` → `version` (this one gets baked into the Windows installer filename and is what `apps/corp`'s `NEXT_PUBLIC_APP_VERSION` must equal)

Bumping only `package.json` leaves the two out of sync and the release half-done. To ship:

```bash
# after both version fields above match, e.g. 0.1.1
git commit -am "chore: bump desktop version to 0.1.1"
git push
git tag v0.1.1
git push origin v0.1.1   # this is what actually starts the build
```

No tag, no build, no new files on R2 — even after a version-bump commit lands on `main`.

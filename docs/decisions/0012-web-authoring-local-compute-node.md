# ADR 0012 — Web-app authoring runs on a paired local compute node; the cloud queues jobs, it does not hold the key

**Date:** 2026-07-13 · **Status:** Proposed · **Deciders:** product + engineering
**Extends:** ADR 0011 (cloud as product pillar) — this is a **second** way to power cloud-side generation, chosen per workspace; 0011's workspace-BYO model key remains valid for teams who want it.
**Builds on:** ADR 0006 (Anthropic façade), ADR 0008 (origin allowlist + per-session bearer), ADR 0009 (BYO external agents), ADR 0010 (sync as projection).
Prompted by the question: *the business team wants to plan a project in the web app using the LLM they already subscribe to and run on their own machine — without a token-brokered provider like OpenRouter. Is that possible?*

## Context

ADR 0011 made `apps/web` **read-first**: browse the graph, ask the RAG assistant, authoring stays in the desktop app. But the business persona is precisely the population that wants to *author* — Scope → Spec → Plan is their work, not the developer's — and is least likely to install a Tauri IDE shell to get it.

The obvious way to let a browser generate is the one 0011 already opened: a **workspace model key in the server secret store**. Product's constraint here closes that door. The team's AI spend is not an API balance; it is a **subscription** (Claude Max, Gemini, ChatGPT) already authenticated on someone's machine, or a personal key that lives in the OS keychain (`apps/engine/src/keychain.ts`, architecture §1.2). Neither is a token-brokered provider, and neither should be copied into the cloud to make the web app work.

Four forces are in tension:

- **The trigger is a browser, the credential is on a laptop.** Something has to bridge them, and only one of the two is addressable from the internet.
- **The engine's front door is deliberately shut.** ADR 0008 binds `127.0.0.1`, allowlists origins (`tauri://localhost`, vite dev) and requires a per-session bearer (`PROMPTZONE_AUTH_TOKEN`). A public web origin is *not* on that list, by design — the CSWSH→RCE finding is what put it there.
- **The browser can no longer quietly reach loopback anyway.** Chrome ships Local Network Access enforcement from 142: a public origin hitting `127.0.0.1` triggers a user permission prompt, split into a distinct `loopback-network` permission in 145 and extended to WebSocket/WebTransport in 147. Enterprise policy can deny it outright.
- **BYO-model is identity, not a cost hack** (0011). Whatever we build must not quietly become "PromptZone calls the model for you."

The enabling asset is that **the engine already authenticates to the cloud as the cloud user** — `cloudClient.ts` holds a Supabase session in the keychain and `sync/loop.ts` already pushes the graph up on an interval. The engine is, today, an outbound cloud client. It does not need a new identity to become a compute node; it needs a new socket.

## Decision

**1 — The engine becomes a compute node, not just a desktop sidecar.** Ship the same `apps/engine` binary as **PromptZone Connector**: a tray/menu-bar installer with no Tauri window, no terminal, no repo. Business users install one thing, sign in once, and close it. Developers already have it — the desktop app registers as a node too.

**2 — The node dials out. The browser never dials in.** The connector opens a persistent WebSocket *from* the engine *to* the cloud (`apps/cloud/app/ws/`, alongside presence) and registers as a compute node for the signed-in user. There is **no change to ADR 0008**: loopback stays closed, the origin allowlist is not widened to a public origin, no new inbound surface exists on the user's machine. This also sidesteps Chrome LNA entirely — no page ever fetches `127.0.0.1`.

```
Browser (apps/web) --job--> Cloud (queue + relay) <==WS== Connector (engine) --> model/agent on the laptop
                <--SSE tokens--            --tokens-->
```

**3 — The cloud queues jobs; it never holds the key.** The web app POSTs an authoring job (`scope | spec | plan | tasks`); the cloud enqueues it, routes it to a live node for that workspace, and relays streamed tokens back to the browser as SSE. The node runs the job through the existing `runStage()` in `agent/loop.ts` against its **own** `ModelConnection` — credential read from the OS keychain, resolved on the laptop, never transmitted. Artifacts land in the graph through the sync projection that already exists (ADR 0010).

**Stated plainly, because it is a real delta:** the cloud sees the **prompt and the completion in transit**. It does not see, store, or proxy the credential. This is the same class of exposure the cloud already accepted when it began storing synced artifacts (0010) and running RAG chat (0011) — but it *is* a step beyond "compute is local, period," and should be named as such rather than discovered later.

**4 — v1 runtimes: subscription CLI agents and the keychain-held personal key.**

| Runtime | Path | Notes |
|---|---|---|
| Subscription CLI agent — **Gemini CLI, Codex** | ADR 0009 adapters, `bringsOwnModel: true` | Already run on the developer's own Google/OpenAI auth. Genuinely "the subscription you already have." Carries the ToS question (§5). |
| Subscription CLI agent — **Claude Code** | **not supported today** | The shipped adapter is `bringsOwnModel: **false**`: it overrides `ANTHROPIC_BASE_URL` to the engine's `/anthropic` façade (ADR 0006) and therefore consumes a **BYO API key**, not a Claude Max seat. Using a Claude *subscription* requires a new `bringsOwnModel: true` variant that leaves the CLI's own login intact. **This is a build item, not an existing capability** — do not assume it works. |
| Personal API key in the OS keychain | existing gateway + `runStage()` | Key never leaves the machine — this is *not* the 0011 server-side key, and not a brokered provider. The path with the least new code. |
| Local model (Ollama / LM Studio) | same gateway path | Works for free by the same mechanism, but **not a v1 target**: long-context Scope→Spec→Plan synthesis is exactly where small local models are weakest, and a plan the business team doesn't trust kills adoption more quietly than an error does. |

**Planning-mode adapter surface — new work.** The 0009 adapters are built for *implementation*: spawn in a repo, capture the result **from Git**. Planning has no repo and no commit; the artifact is the model's stdout. Adapters that `bringsOwnModel` therefore need a `generate(prompt): string` path alongside `buildSpawn()` — headless one-shot (`gemini -p`, `codex exec`), stdout captured as the stage document, parsed by the existing `parseFiles()` / `extractDocument()`. This is the main non-obvious build item in the ADR.

**5 — Node sharing is allowed, opt-in, and default-deny.** Business users will mostly not have a node; the realistic topology is one node (typically the tech lead's) serving the workspace's planning jobs. So:

- The node **owner explicitly offers** the node to a workspace. Nothing is shared by default.
- Every borrowed job carries the **requesting `user_id`**; the owner sees an audit list and can revoke instantly.
- Per-borrower rate limits, reusing the cloud's existing `ratelimit.py`.
- **ToS guardrail:** a personal Claude Max / ChatGPT Plus seat serving *several named users* is the clearest terms-of-service exposure of the three runtimes — materially riskier than the same seat serving its own owner. The UI must warn when a **subscription-seat** node is offered to a workspace, and shared nodes should prefer the **keychain API key** (or a local model) as the backing runtime. Product to confirm against current vendor terms before this ships; recorded here as an accepted, named risk, not an oversight.

**6 — Offline is a product state, not a spinner.** Compute is now a laptop that closes. If no node is online for the workspace, the job **queues** and the UI says so plainly ("your node is offline" / "waiting for Alex's node"), with a queue position and an expiry. Server-side background generation, scheduled runs, and "kick it off and close the lid" remain **impossible by construction** — that is the price of this decision, and the UI should stop pretending otherwise.

## Options considered

### A. Browser fetches `http://127.0.0.1:47131` directly

| Dimension | Assessment |
|---|---|
| Complexity | Low — CORS entry + engine already listening |
| Security | **Poor** — requires adding a public origin to the 0008 allowlist |
| Durability | **Poor** — Chrome LNA prompt (142+), enterprise policy can hard-deny |
| Business-user fit | Poor — a permission dialog about "local network devices" mid-onboarding |

**Pros:** least code; lowest latency; cloud never sees prompt or completion. **Cons:** re-opens exactly the surface ADR 0008 closed (any page could then reach the engine); browser vendors are actively closing this path; per-browser divergence (Chrome/Firefox/Safari) becomes ours to test forever; **works only while a tab is open**.

### B. Reverse-relay compute node (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium — WS relay, job queue, node registry, planning-mode adapters |
| Security | **Good** — no inbound surface; reuses the existing cloud session; 0008 untouched |
| Durability | Good — outbound WS is unaffected by LNA, CORS, or browser policy |
| Business-user fit | Good — one installer, sign in, done; no terminal, no permission dialog |

**Pros:** the credential never leaves the machine; the connector *is* the engine we already ship; pairing is the Supabase session `cloudClient.ts` already holds; works identically for local models, keychain keys, and subscription agents. **Cons:** cloud sees prompt+completion in transit; laptop availability becomes a product surface; a new stateful WS/queue tier to operate.

### C. Browser extension

| Dimension | Assessment |
|---|---|
| Complexity | Medium — plus two store review pipelines |
| Security | Fair — broad host permissions on the user's browser |
| Business-user fit | Fair — install friction comparable to B, with less capability |

**Pros:** host permissions bypass LNA; no relay tier. **Cons:** still tab-bound; store review latency on every fix; an extension with localhost host-permissions is its own attack surface; doesn't help the server-side case at all. **Strictly dominated by B.**

### D. Workspace-BYO cloud key (ADR 0011 as-is) / OpenRouter

| Dimension | Assessment |
|---|---|
| Complexity | Low — already specified in 0011 |
| Business-user fit | **Excellent** — nothing to install, always available |
| Constraint fit | **Fails** — token-brokered spend; key sits server-side |

**Pros:** the only option with true zero-install and server-side background jobs. **Cons:** ruled out by the stated constraint; the team's existing subscription goes unused and they pay twice. **Kept alive as the coexisting alternative** (per this ADR's header) — a workspace picks one.

### E. Cloud runs models on PromptZone's own key

Rejected without analysis: reverses BYO-model, which 0011 named as identity rather than cost policy.

## Trade-off analysis

The decision turns on a single asymmetry: **the browser cannot be trusted to reach the laptop, but the laptop can always reach the cloud.** Option A spends the project's security posture (0008) and bets on browser policy that is visibly moving against it. Option B spends a modest amount of cloud plumbing — most of which (`ws/manager.py`, `ratelimit.py`, `cloudClient.ts`, `runStage()`) is already written — and buys a transport that no browser vendor can deprecate.

The genuine cost of B is not complexity; it is **availability**. We are trading a service that is up 100% of the time (D) for one that is up when a specific laptop is open. That is acceptable for authoring — planning is a deliberate, attended act — and unacceptable for anything scheduled, which is why D must remain selectable rather than be deleted.

The second cost is **honesty about the privacy line**: "compute never leaves your machine" survives; "your text never touches our servers" does not. The credential story is what the constraint actually asked us to protect, and B protects it completely.

## Consequences

**Easier**

- Business users author in the web app with the subscription they already pay for, and the cloud stores no model credential.
- The engine's local security posture (0008) is untouched — no widened allowlist, no new inbound port, no LNA prompt.
- One node type serves everyone: the desktop app and the Connector register identically, so a developer's machine can serve the business team's jobs with no extra build.

**Harder**

- Authoring in the web app is only as available as someone's laptop. Queueing, offline states, and node-picker UI are now product surfaces we own.
- A new stateful tier (node registry + job queue + token relay) to operate, monitor, and reconnect.
- Support burden shifts to installers, sign-in, sleep/wake, and VPNs — the class of problem a pure web app doesn't have.
- Adapter contract grows a planning path (`generate()`), and the 0009 "capture from Git" invariant no longer covers every adapter call.

**To revisit**

- **Vendor ToS on shared subscription seats** (§5) — the one item that could force a redesign of node sharing rather than a tweak.
- Whether the cloud seeing prompts/completions in transit needs an explicit workspace-level disclosure, given 0011's amendments to architecture §2.1.
- If business demand for scheduled/background generation appears, only option D can serve it — that is the trigger to make the coexistence real rather than nominal.

## Action items

1. [ ] Product: confirm Claude Max / ChatGPT Plus / Gemini terms permit (a) app-driven programmatic use and (b) a seat serving other named users. Gate §5 sharing on the answer.
2. [ ] Cloud: node registry + `/ws/compute` endpoint (extend `app/ws/manager.py`); authenticate with the existing Supabase session, scope nodes to workspace membership.
3. [ ] Cloud: authoring job queue + SSE relay to `apps/web`; per-borrower rate limits via `ratelimit.py`.
4. [ ] Engine: outbound compute-node client (sibling of `sync/loop.ts`, reusing `cloudClient.ts` auth); job dispatch into `runStage()`.
5. [ ] Engine: planning-mode adapter path — `generate(prompt)` on `AgentAdapter` (`agent/adapters/types.ts`) for `bringsOwnModel` adapters, stdout capture instead of Git capture.
6. [ ] Engine: **subscription-mode Claude Code adapter** (`bringsOwnModel: true`) that does *not* set `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`, so the CLI uses the user's own Claude login. Without this, "Claude Max" is not actually a supported runtime (§4).
7. [ ] Desktop/Connector: headless tray build of the engine (no Tauri window); first-run sign-in; "offer this node to workspace X" toggle with the subscription-seat warning.
8. [ ] Web: node status indicator, offline/queued job states, node picker (own node vs borrowed).
9. [ ] Security review: job authorization (requester ∈ workspace served by node), node impersonation, and relay abuse — the review that ADR 0008 got, applied to the new tier.

## Open questions

- Does a borrowed job run in the *borrower's* project context on the owner's machine, and if so what filesystem isolation does the node need? (Planning has no repo, so v1 says "none" — but that assumption dies the moment implementation jobs are relayed.)
- Do we allow a workspace to run **both** a compute node and the 0011 workspace key, falling back to the key when no node is online? Attractive, and it quietly reintroduces the brokered-token spend the constraint rejected. Needs an explicit product answer.

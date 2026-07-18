# PromptConnext — Diagrams

Editable Mermaid sources for the system architecture and the usage flow. Render in GitHub, VS Code, or any Mermaid viewer. Companion to [`promptconnext-platform-architecture.md`](./promptconnext-platform-architecture.md).

- **Blue = local** (runs on the user's machine: compute, keys, code).
- **Amber = remote** (cloud / external services).
- Only the **task graph** crosses to the cloud, and only when the user opts in.

---

## 1. System Architecture (all apps & components)

```mermaid
flowchart TB
    subgraph DESKTOP["🖥️ PromptConnext Desktop App — user's machine (VS Code-like shell)"]
        direction TB
        subgraph UI["Dual-Persona UI"]
            direction LR
            BUS["Business Surface<br/><i>Scope · Spec review</i>"]
            DEV["Developer Surface<br/><i>Skill · code · task graph</i>"]
        end
        subgraph ENGINE["Local Engine — background service"]
            direction TB
            THREES["3S Workflow Orchestrator<br/><i>wraps &amp; hides Spec Kit</i>"]
            GATE["Model Gateway + Router<br/><i>provider-agnostic · BYO</i>"]
            SPECKIT["Spec Kit Runner<br/><i>speckit.specify / plan</i>"]
            VAULT["Credential Vault<br/><i>OS keychain</i>"]
            CACHE["Task-Graph Cache<br/><i>offline source of truth</i>"]
            GITL["Git (local)"]
            ONBOARD["First-run Model Onboarding<br/><i>connect &amp; health-check ≥1 model</i>"]
        end
    end

    subgraph MODELS["🔌 Connected AI Models — BYO"]
        direction TB
        PLAN["Planning model · required"]
        CODE["Coding model · required"]
        THAI["Thai model · optional/future"]
        OLLAMA["Local runtime · Ollama"]
    end

    subgraph CLOUD["☁️ PromptConnext Cloud — thin sync + collaboration"]
        direction TB
        SYNC["Sync API<br/><i>task graph · identity</i>"]
        GDB["Task Graph DB<br/><i>Postgres / Supabase</i>"]
        COLLAB["Collaboration<br/><i>presence · comments · roles</i>"]
    end

    subgraph EXT["External Services"]
        direction TB
        JIRA["Jira / ClickUp<br/><i>tracker sync</i>"]
        RGIT["Remote Git<br/><i>GitHub / GitLab</i>"]
        MCP["MCP servers<br/><i>optional tools</i>"]
        PROV["Provider APIs<br/><i>OpenAI · Anthropic · Z.AI…</i>"]
    end

    BUS --> THREES
    DEV --> THREES
    ONBOARD --> GATE
    THREES --> GATE
    THREES --> SPECKIT
    GATE --> VAULT
    THREES --> CACHE
    SPECKIT --> GITL

    GATE -->|routes BYO| PLAN & CODE & THAI & OLLAMA
    PLAN & CODE -. "API / subscription" .-> PROV
    CACHE -. "sync (opt-in)" .-> SYNC
    SYNC --> GDB
    SYNC --> COLLAB
    GITL -. "push / pull" .-> RGIT
    SYNC -. "mirror status" .-> JIRA
    GATE -. "tool calls" .-> MCP

    classDef local stroke:#2563eb,stroke-width:2px;
    classDef remote stroke:#d97706,stroke-width:2px;
    class BUS,DEV,THREES,GATE,SPECKIT,VAULT,CACHE,GITL,ONBOARD,PLAN,CODE,THAI,OLLAMA local;
    class SYNC,GDB,COLLAB,JIRA,RGIT,MCP,PROV remote;
```

---

## 2. Usage Flow (first launch → shipped code)

3S is what the user sees; Spec Kit runs underneath (dashed nodes).

```mermaid
flowchart TB
    START(["New user · first launch"]) --> ONB

    ONB["0 · Model Onboarding — the gate<br/><i>connect &amp; health-check ≥1 model · zero-cost path</i>"]
    ONB -->|"≥1 working model"| SCOPE

    SCOPE["1 · Scope 🟢 Business<br/><i>describe the goal in business terms</i>"]
    SCOPE -.-> SPECIFY[["speckit.specify → Requirement"]]
    SCOPE -->|"approve requirement"| SPEC

    SPEC["2 · Spec 🟢 Business + 🔵 Tech Lead<br/><i>review &amp; approve the plan as the specification</i>"]
    SPEC -.-> PLAN[["speckit.plan → SpecDocument"]]
    SPEC -->|"approve spec"| SKILL

    SKILL["3 · Skill 🔵 Tech Lead<br/><i>configure models · MCP · connect coding model (JIT)</i>"]
    SKILL --> IMPL

    IMPL["4 · Implementation 🔵 Developer + AI<br/><i>tasks routed to models → code, edits, PRs</i>"]
    IMPL -.-> RUN[["router → AgentRun → Artifact · git push"]]
    IMPL --> SEE

    SEE["5 · End-to-end transparency ⚪ Business + Dev<br/><i>requirement → spec → task → who built it → progress</i>"]

    GRAPH{{"AI-native task graph — updates continuously,<br/>the single shared source of truth"}}
    SCOPE -.- GRAPH
    SPEC -.- GRAPH
    SKILL -.- GRAPH
    IMPL -.- GRAPH
    SEE -.- GRAPH

    classDef biz stroke:#0d9488,stroke-width:2px;
    classDef tech stroke:#2563eb,stroke-width:2px;
    classDef any stroke:#6b7280,stroke-width:2px;
    classDef engine stroke:#9ca3af,stroke-dasharray:4 3,fill:#f8f8f7;
    class SCOPE,SPEC biz;
    class SKILL,IMPL tech;
    class ONB,SEE,GRAPH any;
    class SPECIFY,PLAN,RUN engine;
```

### Legend
- 🟢 Business · 🔵 Technical · ⚪ Any/shared
- **Gates** (labels on arrows) block progress until satisfied: a working model, an approved requirement, an approved spec.
- **Dashed engine nodes** are the hidden Spec Kit mechanics the user never sees.

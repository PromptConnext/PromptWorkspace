import type { Article } from "./types";

export const articlesEn: Article[] = [
  // ---------------------------------------------------------------- COMPARE
  {
    collection: "compare",
    slug: "promptconnext-vs-cursor",
    eyebrow: "Compare",
    title: "PromptConnext vs Cursor",
    description:
      "How PromptConnext compares to Cursor: bring-your-own-model orchestration and end-to-end transparency versus an AI-first code editor.",
    intro: [
      "Cursor is an AI-first code editor that developers use to write and refactor code quickly. PromptConnext is an AI-native workspace for the whole team that takes a project from business requirement to running code. They overlap on AI-assisted coding, but they solve different problems.",
      "If you want a faster editor for individual developers, Cursor is excellent. If you want business and engineering working from the same plan, over the models you already pay for, with a traceable record of every step, that is what PromptConnext is built for.",
    ],
    sections: [
      {
        heading: "Who it's for",
        body: [
          "Cursor targets developers in the editor. PromptConnext targets the whole delivery team — business users define scope and approve specs, developers take over implementation, and both watch the same progress.",
          "That is the core difference: PromptConnext is not just where code gets written, it is where a project is defined, agreed, and tracked end to end.",
        ],
      },
      {
        heading: "Bring your own model, no model tax",
        body: [
          "PromptConnext connects the models you already pay for — cloud API keys, agentic sign-in where allowed, or fully local models via Ollama — and never marks up tokens. You choose the model per role and keep control of cost and privacy.",
        ],
      },
      {
        heading: "Transparency and traceability",
        body: [
          "Every requirement, spec, task, artifact, and agent run lives in one graph in PromptConnext, so how the software got built is auditable. Your code and keys stay on your machine; only the shared task graph syncs when you choose to collaborate.",
        ],
      },
    ],
    table: {
      title: "At a glance",
      columns: ["", "PromptConnext", "Cursor"],
      rows: [
        ["Primary audience", "Business + developers", "Developers"],
        ["Scope", "Requirement → spec → code", "Code editing"],
        ["Bring your own model", "Yes, no model tax", "Partial (BYO keys)"],
        ["Local-first privacy", "Code & keys stay local", "Editor-based"],
        ["Traceable task graph", "Yes", "No"],
        ["Price", "Free desktop app", "Subscription tiers"],
      ],
    },
    faqs: [
      {
        question: "Can I use PromptConnext with my own IDE?",
        answer:
          "Yes. PromptConnext orchestrates your workflow and coding agent, and you can continue coding in the editor you prefer. It is not trying to replace your editor.",
      },
      {
        question: "Is PromptConnext free?",
        answer:
          "The desktop app is free. You bring your own model and pay your provider directly. Enterprise collaboration features are available via sales.",
      },
    ],
  },
  {
    collection: "compare",
    slug: "promptconnext-vs-github-copilot",
    eyebrow: "Compare",
    title: "PromptConnext vs GitHub Copilot",
    description:
      "PromptConnext versus GitHub Copilot: an end-to-end 3S workflow with your own models compared to inline code completion.",
    intro: [
      "GitHub Copilot is an inline coding assistant that suggests and completes code inside your editor. PromptConnext is a workspace that carries a whole project from business scope to shipped code. They are complementary rather than direct substitutes.",
      "Copilot makes typing code faster. PromptConnext makes the entire path — requirement, specification, implementation, and traceability — visible to business and engineering at once.",
    ],
    sections: [
      {
        heading: "Scope of the tool",
        body: [
          "Copilot lives in the editor and focuses on code generation. PromptConnext covers the earlier and later stages too: defining scope in business language, approving a specification, and recording every AI action against the task it served.",
        ],
      },
      {
        heading: "Model choice",
        body: [
          "Copilot runs on the models GitHub provides. PromptConnext is bring-your-own-model: connect OpenAI, Anthropic, Google, OpenRouter, or a local model, with no markup. That keeps cost, capability, and privacy in your hands.",
        ],
      },
      {
        heading: "Team transparency",
        body: [
          "Copilot is a personal productivity tool. PromptConnext is a shared surface: business stakeholders and developers see the same requirement-to-code lineage, which is difficult to reconstruct from inline completions alone.",
        ],
      },
    ],
    table: {
      title: "At a glance",
      columns: ["", "PromptConnext", "GitHub Copilot"],
      rows: [
        ["Primary job", "Requirement → running code", "Code completion"],
        ["Audience", "Business + developers", "Developers"],
        ["Bring your own model", "Yes, no model tax", "No (provider models)"],
        ["Traceability graph", "Yes", "No"],
        ["Runs locally", "Yes (local models)", "Cloud"],
        ["Price", "Free desktop app", "Subscription"],
      ],
    },
    faqs: [
      {
        question: "Can I use both together?",
        answer:
          "Yes. Many teams keep Copilot for inline completion in the editor while using PromptConnext for scope, specs, orchestration, and traceability.",
      },
    ],
  },
  {
    collection: "compare",
    slug: "promptconnext-vs-devin",
    eyebrow: "Compare",
    title: "PromptConnext vs Devin",
    description:
      "PromptConnext versus Devin: transparent, team-visible delivery with your own models compared to an autonomous AI software engineer.",
    intro: [
      "Devin is marketed as an autonomous AI software engineer that takes a task and tries to complete it end to end. PromptConnext keeps humans in the loop across a transparent 3S workflow and orchestrates the coding agent and models you choose.",
      "The philosophies differ: Devin leans toward autonomy, PromptConnext toward transparency and control.",
    ],
    sections: [
      {
        heading: "Autonomy vs transparency",
        body: [
          "With PromptConnext, every stage has an approval gate and every AI action is recorded in the task graph, so nothing is a black box. That suits teams that need to review, audit, and trust what the AI did.",
        ],
      },
      {
        heading: "Your models, your machine",
        body: [
          "PromptConnext is bring-your-own-model and local-first: connect the models you already pay for, run them locally if you prefer, and keep code and keys on your machine. You are not locked into one provider's agent.",
        ],
      },
      {
        heading: "Bring your own agent",
        body: [
          "Rather than a single built-in agent, PromptConnext orchestrates the coding agent you choose — Claude Code, Gemini CLI, or a custom CLI — and captures results from Git.",
        ],
      },
    ],
    table: {
      title: "At a glance",
      columns: ["", "PromptConnext", "Devin"],
      rows: [
        ["Approach", "Human-in-the-loop, transparent", "Autonomous agent"],
        ["Model choice", "Bring your own", "Provider-managed"],
        ["Traceability", "Full task graph", "Limited visibility"],
        ["Local-first", "Yes", "Cloud"],
        ["Audience", "Business + developers", "Developers"],
      ],
    },
    faqs: [
      {
        question: "Does PromptConnext run tasks autonomously?",
        answer:
          "It can run a coding agent on a task, but within a transparent workflow with approval gates and a full record of each action — you stay in control.",
      },
    ],
  },
  {
    collection: "compare",
    slug: "promptconnext-vs-lovable",
    eyebrow: "Compare",
    title: "PromptConnext vs Lovable",
    description:
      "PromptConnext versus Lovable: a business-to-developer workflow over your own models compared to prompt-to-app generation.",
    intro: [
      "Lovable generates web apps from natural-language prompts, aimed at quickly producing a working front end. PromptConnext is a team workspace that carries a project from business requirement to running code with full traceability.",
      "If you want to spin up a prototype from a prompt, Lovable is fast. If you need business and engineering aligned on a spec and an auditable path to production, PromptConnext fits better.",
    ],
    sections: [
      {
        heading: "From prototype to process",
        body: [
          "Lovable emphasizes rapid generation. PromptConnext emphasizes a repeatable process: scope, an approved specification, implementation by your chosen agent, and a traceable record — the things teams need beyond a first prototype.",
        ],
      },
      {
        heading: "Own your models and code",
        body: [
          "PromptConnext connects your own models with no markup and keeps your code and keys local. You are not tied to a hosted generation service.",
        ],
      },
    ],
    table: {
      title: "At a glance",
      columns: ["", "PromptConnext", "Lovable"],
      rows: [
        ["Primary job", "Requirement → running code", "Prompt → app"],
        ["Audience", "Business + developers", "Builders / makers"],
        ["Bring your own model", "Yes, no model tax", "Hosted models"],
        ["Traceability graph", "Yes", "No"],
        ["Local-first", "Yes", "Cloud"],
      ],
    },
    faqs: [
      {
        question: "Is PromptConnext only for web apps?",
        answer:
          "No. PromptConnext is agnostic about what you build; it orchestrates your models and coding agent around any project the agent can work on.",
      },
    ],
  },
  {
    collection: "compare",
    slug: "promptconnext-vs-windsurf",
    eyebrow: "Compare",
    title: "PromptConnext vs Windsurf",
    description:
      "PromptConnext versus Windsurf: an end-to-end, team-visible workflow over your own models compared to an agentic AI editor.",
    intro: [
      "Windsurf is an agentic AI code editor focused on developer flow. PromptConnext is a workspace for the whole team that spans scope, specification, and implementation with a traceable task graph.",
      "Both use AI heavily, but PromptConnext widens the audience beyond the editor and keeps the model layer open.",
    ],
    sections: [
      {
        heading: "Editor vs workspace",
        body: [
          "Windsurf optimizes the developer's editing experience. PromptConnext adds the business-facing stages and a shared record so a project is defined, agreed, and tracked — not just coded.",
        ],
      },
      {
        heading: "Open model layer",
        body: [
          "PromptConnext is bring-your-own-model with no markup and a local-first privacy posture, so you control which models run and where your code lives.",
        ],
      },
    ],
    table: {
      title: "At a glance",
      columns: ["", "PromptConnext", "Windsurf"],
      rows: [
        ["Primary job", "Requirement → running code", "AI code editing"],
        ["Audience", "Business + developers", "Developers"],
        ["Bring your own model", "Yes, no model tax", "Partial"],
        ["Traceability graph", "Yes", "No"],
        ["Local-first", "Yes", "Editor-based"],
      ],
    },
    faqs: [
      {
        question: "Can PromptConnext work alongside an AI editor?",
        answer:
          "Yes. Use PromptConnext for scope, specs, orchestration, and traceability, and keep coding in whichever editor your team prefers.",
      },
    ],
  },

  {
    collection: "compare",
    slug: "best-ai-coding-tools-bring-your-own-model",
    eyebrow: "Compare",
    title: "Best AI coding tools that let you bring your own model",
    description:
      "A practical roundup of AI development tools that let you connect your own models and keys — cloud or local — instead of paying a model tax.",
    intro: [
      "Most AI coding tools bundle a model and bill you for it. A growing group instead lets you bring your own model (BYO): you connect the keys or local models you already have and pay the provider directly. Here is how to think about the category and where PromptConnext fits.",
      "The criteria that matter for BYO: which providers and endpoints are supported, whether local models work, whether there is any token markup, and how much of the workflow the tool covers beyond the editor.",
    ],
    sections: [
      {
        heading: "What to look for",
        body: [
          "Provider breadth: support for OpenAI-compatible endpoints means you can connect OpenAI, Anthropic, Google, OpenRouter, and many others with one mechanism.",
          "Local support: tools that speak to Ollama or vLLM let you run fully offline at zero token cost — important for privacy-sensitive teams.",
          "No model tax: check whether the tool marks up tokens or resells inference. BYO should mean you pay your provider directly.",
          "Workflow depth: some tools stop at code completion; others cover scope, specification, and traceability across the whole delivery.",
        ],
      },
      {
        heading: "Where PromptConnext fits",
        body: [
          "PromptConnext is bring-your-own-model with no markup, supports OpenAI-compatible endpoints and local Ollama, and orchestrates your coding agent (Claude Code, Gemini CLI, or custom). Beyond the editor, it covers the full 3S workflow and keeps a traceable task graph — so it is a fit when you want both model freedom and end-to-end transparency.",
        ],
      },
      {
        heading: "How to choose",
        body: [
          "If you only need inline completion, a lightweight editor plug-in with BYO keys may be enough. If you need business and engineering aligned on a spec, local-model support, and an auditable path from requirement to code, choose a workspace-level tool like PromptConnext.",
        ],
      },
    ],
    faqs: [
      {
        question: "Does bring-your-own-model always mean cheaper?",
        answer:
          "Not always, but it removes any markup the tool would add and lets you choose cheaper or local models. You control the cost by choosing the model per task.",
      },
    ],
  },
  {
    collection: "compare",
    slug: "best-local-first-ai-coding-tools",
    eyebrow: "Compare",
    title: "Best local-first, private AI coding tools",
    description:
      "AI development tools that keep your code and inference on your own machine — for privacy-sensitive and regulated teams.",
    intro: [
      "For regulated or security-conscious teams, sending code and prompts to third-party clouds is often a non-starter. Local-first tools keep source code, prompts, and sometimes inference on your own machine. Here is what to evaluate and where PromptConnext stands.",
    ],
    sections: [
      {
        heading: "What 'local-first' should mean",
        body: [
          "Local inference: the ability to run models on your machine (via Ollama or vLLM) so prompts and code never leave your boundary.",
          "Local data: your source code and credentials stay on the device; keys live in the OS keychain rather than a vendor cloud.",
          "Optional sync: any collaboration should move only what you choose — ideally metadata, never your source code.",
        ],
      },
      {
        heading: "Where PromptConnext fits",
        body: [
          "PromptConnext is local-first by design: connect local models, keep code and keys on the machine, and work fully offline. When you collaborate, only the shared task graph syncs — never your code. That makes it suitable for teams that cannot use cloud-only assistants.",
        ],
      },
    ],
    faqs: [
      {
        question: "Can I use a local model and still collaborate?",
        answer:
          "Yes. Inference stays local, and collaboration syncs only the task graph (requirements, specs, tasks, and agent-run records) — not your source code.",
      },
    ],
  },

  // ----------------------------------------------------------------- GUIDES
  {
    collection: "guides",
    slug: "what-is-spec-driven-development",
    eyebrow: "Guide",
    title: "What is spec-driven development?",
    description:
      "A practical introduction to spec-driven development — the approach behind PromptConnext's 3S workflow — and why it makes AI-assisted delivery predictable.",
    intro: [
      "Spec-driven development means agreeing on a clear specification before implementation begins, then treating that spec as the source of truth the whole team works from. With AI in the loop, it becomes even more valuable: a good spec gives the model precise, reviewable intent to build against.",
      "PromptConnext turns this into a guided experience — Scope, Spec, Skill — so business and engineering align before code is written.",
    ],
    sections: [
      {
        heading: "Why a spec matters with AI",
        body: [
          "AI models produce better results when given clear, structured intent. A specification captures that intent in a form everyone can review, so you catch misunderstandings early rather than after code is generated.",
          "It also creates accountability: when the spec is approved, implementation has an agreed target instead of a moving one.",
        ],
      },
      {
        heading: "The three stages",
        body: [
          "Scope captures what the project should achieve in business terms. Spec turns that into a reviewable plan that must be approved. Skill equips the project with the models and agent that implement it. Approval gates between stages keep work from running ahead of agreement.",
        ],
      },
      {
        heading: "Where the transparency comes from",
        body: [
          "Because the spec ties down to tasks, and tasks tie to the agent runs and artifacts that fulfill them, you get an auditable trail from requirement to running code.",
        ],
      },
    ],
    faqs: [
      {
        question: "Is spec-driven development slower?",
        answer:
          "It front-loads a little alignment, but it usually saves time overall by preventing rework — especially when AI generates code against a clear, approved spec.",
      },
    ],
  },
  {
    collection: "guides",
    slug: "bring-your-own-model-explained",
    eyebrow: "Guide",
    title: "Bring-your-own-model AI coding, explained",
    description:
      "What bring-your-own-model means, the two honest connection modes, and how to avoid paying a model tax on AI-assisted development.",
    intro: [
      "Bring-your-own-model (BYO) means the tool orchestrates AI you already have rather than reselling its own. You connect your keys or local models, and you pay the provider directly — no markup, or 'model tax', in between.",
      "There is an important honesty point: a consumer chat subscription is not the same as API access.",
    ],
    sections: [
      {
        heading: "Two connection modes",
        body: [
          "API key / endpoint: paste a key or an OpenAI-compatible base URL. Works with OpenAI, Anthropic, Google, OpenRouter, and local Ollama or vLLM. Billed per token by the provider.",
          "Subscription / agentic sign-in: sign in with a plan where the provider allows programmatic use. Availability varies, and some providers prohibit proxying a chat plan as an API.",
        ],
      },
      {
        heading: "The honesty rule",
        body: [
          "A ChatGPT Plus or Claude Pro subscription does not automatically grant general API access — that is billed separately. So 'use the AI you already pay for' is true for API keys you hold, local models, and agentic sign-in where supported, but it is not a blanket promise. A good tool names the mode you are using.",
        ],
      },
      {
        heading: "A zero-cost path",
        body: [
          "Local models via Ollama let you start with no spend at all — useful for privacy-sensitive teams and for evaluating the workflow before connecting a paid model.",
        ],
      },
    ],
    faqs: [
      {
        question: "Can I reuse my ChatGPT subscription as an API?",
        answer:
          "Usually not directly — API access is billed separately from chat subscriptions. You can use API keys you already hold, local models, or agentic sign-in where the provider permits it.",
      },
    ],
  },
  {
    collection: "guides",
    slug: "run-ai-coding-locally-with-ollama",
    eyebrow: "Guide",
    title: "How to run AI coding locally with Ollama",
    description:
      "A zero-cost, privacy-first setup for AI-assisted development using local models with Ollama and PromptConnext.",
    intro: [
      "Running models locally keeps your code and prompts on your own machine and costs nothing per token. Ollama makes this simple, and PromptConnext can use a local Ollama model for the planning and coding roles.",
    ],
    sections: [
      {
        heading: "Install and pull a model",
        body: [
          "Install Ollama, then pull a capable open model — for example a mid-size code-friendly model. Larger models give better results if your hardware allows; smaller ones start faster.",
        ],
      },
      {
        heading: "Connect it in onboarding",
        body: [
          "In PromptConnext's first-run onboarding, choose the local Ollama option and health-check it. Once it responds, you can complete Scope and Spec on a fully local model at zero cost.",
        ],
      },
      {
        heading: "When to add a cloud model",
        body: [
          "Local models are great for privacy and evaluation. For the heaviest implementation work, you can connect a stronger cloud model for the coding role while keeping planning local — PromptConnext routes each task to the model you assign.",
        ],
      },
    ],
    faqs: [
      {
        question: "Do I need a powerful machine?",
        answer:
          "A smaller local model runs on modest hardware; larger models need more memory. You can always connect a cloud model for heavier tasks and keep lighter work local.",
      },
    ],
  },
  {
    collection: "guides",
    slug: "keeping-ai-generated-code-auditable",
    eyebrow: "Guide",
    title: "Keeping AI-generated code auditable",
    description:
      "How a task-graph approach records every AI action against the work it served, so AI-assisted delivery stays reviewable and trustworthy.",
    intro: [
      "As AI writes more code, teams need to answer a simple question: how did this get built? Without a record, AI-assisted work becomes a black box. A task graph solves this by linking every requirement, spec, task, artifact, and agent run.",
    ],
    sections: [
      {
        heading: "What the graph records",
        body: [
          "Each requirement leads to a spec, which breaks into tasks. Each task links to the artifacts produced for it and the agent runs that produced them. The result is a lineage from business intent to the exact change that fulfilled it.",
        ],
      },
      {
        heading: "Why it matters",
        body: [
          "Auditability supports code review, compliance, and onboarding. When someone asks why a change exists, the graph answers with the requirement and the agent run behind it — not guesswork.",
        ],
      },
    ],
    faqs: [
      {
        question: "Does this slow developers down?",
        answer:
          "No — the record is captured as work happens (for example, from Git commits that reference a task), so traceability is a by-product of normal work rather than extra effort.",
      },
    ],
  },

  // -------------------------------------------------------------- USE CASES
  {
    collection: "use-cases",
    slug: "for-startups",
    eyebrow: "Use case",
    title: "PromptConnext for startups and greenfield teams",
    description:
      "Move from idea to shipping software fast, with just enough process, using the AI models you already pay for.",
    intro: [
      "Early teams need speed without chaos. PromptConnext gives a lightweight path from idea to running code — enough structure to stay aligned, not so much that it slows you down.",
    ],
    sections: [
      {
        heading: "Start with no model spend",
        body: [
          "Use a free local model via Ollama to begin, then connect a paid model only when you need more capability. There is no model tax, so your AI budget goes to the provider, not the tool.",
        ],
      },
      {
        heading: "Keep founders and engineers aligned",
        body: [
          "A non-technical founder can define scope and approve a spec while an engineer takes over implementation — both watching the same progress. That alignment is hard to keep as a team grows, and the 3S workflow preserves it.",
        ],
      },
    ],
    faqs: [
      {
        question: "Is it overkill for a tiny team?",
        answer:
          "No. The workflow is light by default and the app is free — you get alignment and traceability without adopting heavy process.",
      },
    ],
  },
  {
    collection: "use-cases",
    slug: "for-product-managers",
    eyebrow: "Use case",
    title: "PromptConnext for product managers",
    description:
      "Delivery transparency from requirement to running code, so product managers can see how work maps to outcomes.",
    intro: [
      "Product managers often lose sight of how a requirement becomes shipped software. PromptConnext keeps that connection visible: scope, approved spec, tasks, and the AI actions that fulfilled them, all in one place.",
    ],
    sections: [
      {
        heading: "Define scope without a CLI",
        body: [
          "Describe what a feature should achieve in plain language. PromptConnext generates a structured specification you can review and approve — no engineering tooling required to participate.",
        ],
      },
      {
        heading: "Follow delivery in real time",
        body: [
          "Once engineering takes over at the Skill stage, you keep watching the same progress. The task graph shows what is done, in progress, and traceable back to the requirement.",
        ],
      },
    ],
    faqs: [
      {
        question: "Do I need engineering to set this up?",
        answer:
          "You can define scope and review specs independently. Engineering handles model and agent configuration at the Skill stage.",
      },
    ],
  },
  {
    collection: "use-cases",
    slug: "for-enterprises-local-models",
    eyebrow: "Use case",
    title: "PromptConnext for enterprises needing local models",
    description:
      "Keep code and inference on-premises with bring-your-own-model and a local-first privacy posture.",
    intro: [
      "Regulated and security-conscious enterprises often cannot send code or prompts to third-party clouds. PromptConnext supports fully local models and keeps code and keys on the machine, so AI-assisted development stays inside your boundary.",
    ],
    sections: [
      {
        heading: "Local-first by design",
        body: [
          "Connect local models via Ollama or vLLM. Your source code and credentials never leave the device, and only the shared task graph syncs when you choose to collaborate — never your code.",
        ],
      },
      {
        heading: "Enterprise controls",
        body: [
          "For teams, shared workspaces add SSO, role-based access, and two-way Jira/ClickUp status sync, while the AI-native graph stays authoritative for traceability. Talk to sales to enable these.",
        ],
      },
    ],
    faqs: [
      {
        question: "Can we run entirely offline?",
        answer:
          "The desktop app and local models work offline. Collaboration sync is optional and only moves the task graph, not your code.",
      },
    ],
  },
  {
    collection: "use-cases",
    slug: "for-thai-sea-teams",
    eyebrow: "Use case",
    title: "PromptConnext for Thai and Southeast Asian teams",
    description:
      "Local-language workflows and local-model support for teams in Thailand and across Southeast Asia.",
    intro: [
      "Teams in Thailand and the wider region often work across Thai and English and care about data locality. PromptConnext is built with this in mind, with a bilingual interface and support for local and regional models.",
    ],
    sections: [
      {
        heading: "Work in your language",
        body: [
          "The workspace and this site are available in Thai and English, so business users can define scope in the language they think in while engineering works in the same project.",
        ],
      },
      {
        heading: "Local and regional models",
        body: [
          "Connect local models for privacy, or regional and Thai-capable models as they mature. Because PromptConnext is bring-your-own-model, you are free to choose the model that fits your language and compliance needs.",
        ],
      },
    ],
    faqs: [
      {
        question: "Is the product available in Thai?",
        answer:
          "Yes. The interface and marketing site support Thai and English, and you can connect Thai-capable models under the bring-your-own-model approach.",
      },
    ],
  },
];

/**
 * Content for the product feature pages, keyed by locale then slug.
 * Rendered by src/app/[locale]/product/[slug]/page.tsx. Add a feature page by
 * adding an entry to BOTH locale arrays (matched by slug); the route, metadata,
 * and sitemap pick it up automatically.
 */
import type { Locale } from "@/i18n/routing";

export type ProductSection = { heading: string; body: string };

export type ProductPage = {
  slug: string;
  eyebrow: string;
  title: string;
  description: string;
  sections: ProductSection[];
};

const en: ProductPage[] = [
  {
    slug: "3s-workflow",
    eyebrow: "3S Workflow",
    title: "Scope → Spec → Skill: from requirement to running code",
    description:
      "The 3S experience is the product language layered over a proven spec-driven engine. Users move through three guided stages and never need to know the engine exists.",
    sections: [
      {
        heading: "Scope — describe the outcome",
        body: "Business users describe what the project should achieve in plain language. PromptConnext generates a structured specification behind the scenes — no CLI, no templates, no jargon.",
      },
      {
        heading: "Spec — review and approve",
        body: "The generated plan is presented as the project specification for review. Approval is an explicit gate: you can't reach Skill without an approved Spec, so work never runs ahead of agreement.",
      },
      {
        heading: "Skill — equip and build",
        body: "The tech lead configures the models, coding agent, and MCP servers that will implement the project. This is the handoff from business to engineering, and where bring-your-own-model connection is enforced.",
      },
    ],
  },
  {
    slug: "bring-your-own-model",
    eyebrow: "Bring Your Own Model",
    title: "Connect the AI you already pay for — cloud or local",
    description:
      "PromptConnext is an orchestration layer, not a proprietary model. Connect API keys, local models, or agentic sign-in, and route each task to the model best suited to it.",
    sections: [
      {
        heading: "Two honest connection modes",
        body: "Connect via API key / OpenAI-compatible endpoint (OpenAI, Anthropic, Google, OpenRouter, local Ollama/vLLM), or via subscription / agentic sign-in where a provider allows programmatic use. We always name the mode and its billing so there are no surprises.",
      },
      {
        heading: "A zero-cost path to start",
        body: "First-run onboarding guides you to connect and health-check at least one working model before you enter the workspace — including a free local Ollama option, so a team with no prior AI spend can still get going.",
      },
      {
        heading: "No model tax",
        body: "You pay your model provider directly. PromptConnext never marks up tokens or resells inference — its value is orchestration, workflow, and transparency.",
      },
    ],
  },
  {
    slug: "task-graph",
    eyebrow: "Task Graph",
    title: "Every requirement, spec, task, and agent run — traceable",
    description:
      "PromptConnext's moat is an AI-native execution graph that ties a business requirement all the way down to the agent run that produced the code for it.",
    sections: [
      {
        heading: "One lineage, two altitudes",
        body: "Requirement → spec → task → artifact → agent-run → progress. Business and technical users see the same graph at the level of detail that matters to them.",
      },
      {
        heading: "Auditable by construction",
        body: "Because every AI action is recorded against the task it served, how your software got built is never a black box — useful for reviews, compliance, and onboarding.",
      },
      {
        heading: "Private by default",
        body: "Your code and model keys stay on your machine. The cloud holds only the shared task graph when you choose to sync — never your source or your credentials.",
      },
    ],
  },
  {
    slug: "collaboration",
    eyebrow: "Collaboration",
    title: "Business and engineering in one workspace",
    description:
      "One project, two personas, the same source of truth. Share the requirement-to-code lineage with your whole team and sync on demand.",
    sections: [
      {
        heading: "Workspaces and roles",
        body: "Group projects into shared workspaces, invite teammates, and manage access by role. Collaboration is opt-in and scoped to your team.",
      },
      {
        heading: "Sync on your terms",
        body: "The local graph is the source of truth and works fully offline. Changes reach teammates when you push, and theirs reach you when you pull — predictable, Git-like, and conflict-safe.",
      },
      {
        heading: "Enterprise-ready",
        body: "SSO, two-way Jira/ClickUp status sync, and admin controls are available for teams that need them. Talk to sales to enable them for your organization.",
      },
    ],
  },
  {
    slug: "integrations",
    eyebrow: "Integrations",
    title: "Works with the tools and agents you already use",
    description:
      "PromptConnext orchestrates your existing stack rather than replacing it. Bring your coding agent, your models, and your trackers.",
    sections: [
      {
        heading: "Coding agents",
        body: "Claude Code (routed to your connected model), Gemini CLI, Codex CLI, or any custom CLI agent. If no agent is installed, a built-in one-shot generator runs on a connected coding model.",
      },
      {
        heading: "Models and endpoints",
        body: "OpenAI, Anthropic, Google, OpenRouter, and any OpenAI-compatible endpoint — plus local Ollama and vLLM for fully private inference.",
      },
      {
        heading: "Trackers and tools",
        body: "Two-way status sync with Jira and ClickUp keeps PMO fields aligned, while the AI-native graph stays authoritative for agent runs and traceability. Extend further with MCP servers.",
      },
    ],
  },
];

const th: ProductPage[] = [
  {
    slug: "3s-workflow",
    eyebrow: "ขั้นตอน 3S",
    title: "Scope → Spec → Skill: จากความต้องการสู่โค้ดที่ทำงานได้",
    description:
      "ประสบการณ์ 3S คือภาษาผลิตภัณฑ์ที่วางทับบนเอนจินแบบ spec-driven ที่พิสูจน์แล้ว ผู้ใช้เดินผ่านสามขั้นตอนแบบมีไกด์ โดยไม่จำเป็นต้องรู้ว่าเอนจินมีอยู่",
    sections: [
      {
        heading: "Scope — อธิบายผลลัพธ์",
        body: "ผู้ใช้ฝ่ายธุรกิจอธิบายสิ่งที่โปรเจกต์ควรบรรลุด้วยภาษาธรรมดา PromptConnext สร้างสเปกที่มีโครงสร้างอยู่เบื้องหลัง — ไม่มี CLI ไม่มีเทมเพลต ไม่มีศัพท์เทคนิค",
      },
      {
        heading: "Spec — ตรวจทานและอนุมัติ",
        body: "แผนที่สร้างขึ้นถูกนำเสนอเป็นสเปกของโปรเจกต์เพื่อตรวจทาน การอนุมัติเป็นจุดกั้นที่ชัดเจน: คุณไปถึง Skill ไม่ได้หากไม่มี Spec ที่อนุมัติแล้ว งานจึงไม่ล้ำหน้าไปกว่าที่ตกลงกัน",
      },
      {
        heading: "Skill — จัดเตรียมและสร้าง",
        body: "หัวหน้าทีมเทคนิคตั้งค่าโมเดล เอเจนต์เขียนโค้ด และเซิร์ฟเวอร์ MCP ที่จะพัฒนาโปรเจกต์ นี่คือจุดส่งต่อจากธุรกิจสู่วิศวกรรม และเป็นจุดที่บังคับใช้การเชื่อมต่อโมเดลของคุณเอง",
      },
    ],
  },
  {
    slug: "bring-your-own-model",
    eyebrow: "ใช้โมเดลของคุณเอง",
    title: "เชื่อมต่อ AI ที่คุณจ่ายอยู่แล้ว — คลาวด์หรือในเครื่อง",
    description:
      "PromptConnext เป็นชั้นประสานงาน ไม่ใช่โมเดลกรรมสิทธิ์ เชื่อมต่อคีย์ API โมเดลในเครื่อง หรือการล็อกอินแบบเอเจนต์ แล้วส่งแต่ละงานไปยังโมเดลที่เหมาะที่สุด",
    sections: [
      {
        heading: "โหมดการเชื่อมต่อสองแบบที่ตรงไปตรงมา",
        body: "เชื่อมต่อผ่านคีย์ API / เอนด์พอยต์ที่เข้ากันได้กับ OpenAI (OpenAI, Anthropic, Google, OpenRouter, Ollama/vLLM ในเครื่อง) หรือผ่านการล็อกอินแบบสมาชิก/เอเจนต์เมื่อผู้ให้บริการอนุญาตให้ใช้แบบโปรแกรม เราจะบอกโหมดและการคิดเงินเสมอเพื่อไม่ให้มีเรื่องเซอร์ไพรส์",
      },
      {
        heading: "เส้นทางเริ่มต้นแบบไม่มีค่าใช้จ่าย",
        body: "การออนบอร์ดครั้งแรกจะแนะนำให้คุณเชื่อมต่อและตรวจสุขภาพโมเดลที่ใช้งานได้อย่างน้อยหนึ่งตัวก่อนเข้าเวิร์กสเปซ — รวมถึงตัวเลือก Ollama ในเครื่องแบบฟรี ทีมที่ยังไม่เคยจ่ายค่า AI จึงเริ่มได้",
      },
      {
        heading: "ไม่มีค่าธรรมเนียมโมเดล",
        body: "คุณจ่ายผู้ให้บริการโมเดลโดยตรง PromptConnext ไม่บวกค่าโทเคนหรือขายต่อการประมวลผล — คุณค่าของมันคือการประสานงาน เวิร์กโฟลว์ และความโปร่งใส",
      },
    ],
  },
  {
    slug: "task-graph",
    eyebrow: "กราฟงาน",
    title: "ทุกความต้องการ สเปก งาน และการรันเอเจนต์ — ตรวจสอบย้อนกลับได้",
    description:
      "จุดแข็งของ PromptConnext คือกราฟการทำงานแบบ AI-native ที่ผูกความต้องการทางธุรกิจลงไปจนถึงการรันเอเจนต์ที่ผลิตโค้ดให้",
    sections: [
      {
        heading: "หนึ่งสายโยง สองระดับความละเอียด",
        body: "ความต้องการ → สเปก → งาน → อาร์ติแฟกต์ → การรันเอเจนต์ → ความคืบหน้า ผู้ใช้ฝ่ายธุรกิจและเทคนิคเห็นกราฟเดียวกันในระดับรายละเอียดที่สำคัญต่อตน",
      },
      {
        heading: "ตรวจสอบได้โดยการออกแบบ",
        body: "เพราะทุกการกระทำของ AI ถูกบันทึกให้ผูกกับงานที่มันทำ การสร้างซอฟต์แวร์ของคุณจึงไม่เป็นกล่องดำ — มีประโยชน์ต่อการรีวิว การปฏิบัติตามข้อกำหนด และการออนบอร์ด",
      },
      {
        heading: "เป็นส่วนตัวโดยค่าเริ่มต้น",
        body: "โค้ดและคีย์โมเดลของคุณอยู่บนเครื่อง คลาวด์เก็บเฉพาะกราฟงานที่แชร์เมื่อคุณเลือกซิงก์ — ไม่ใช่ซอร์สโค้ดหรือข้อมูลรับรองของคุณ",
      },
    ],
  },
  {
    slug: "collaboration",
    eyebrow: "การทำงานร่วมกัน",
    title: "ธุรกิจและวิศวกรรมในเวิร์กสเปซเดียว",
    description:
      "หนึ่งโปรเจกต์ สองบทบาท แหล่งความจริงเดียวกัน แชร์สายโยงจากความต้องการถึงโค้ดกับทั้งทีมและซิงก์เมื่อต้องการ",
    sections: [
      {
        heading: "เวิร์กสเปซและบทบาท",
        body: "จัดกลุ่มโปรเจกต์เข้าเป็นเวิร์กสเปซที่แชร์ เชิญเพื่อนร่วมทีม และจัดการการเข้าถึงตามบทบาท การทำงานร่วมกันเป็นแบบเลือกเข้าร่วมและจำกัดขอบเขตไว้ที่ทีมของคุณ",
      },
      {
        heading: "ซิงก์ในแบบของคุณ",
        body: "กราฟในเครื่องเป็นแหล่งความจริงและทำงานออฟไลน์ได้เต็มที่ การเปลี่ยนแปลงถึงเพื่อนร่วมทีมเมื่อคุณ push และของพวกเขาถึงคุณเมื่อคุณ pull — คาดเดาได้ คล้าย Git และปลอดภัยจากความขัดแย้ง",
      },
      {
        heading: "พร้อมสำหรับองค์กร",
        body: "SSO การซิงก์สถานะสองทางกับ Jira/ClickUp และการควบคุมสำหรับผู้ดูแล มีให้สำหรับทีมที่ต้องการ ติดต่อฝ่ายขายเพื่อเปิดใช้งานให้องค์กรของคุณ",
      },
    ],
  },
  {
    slug: "integrations",
    eyebrow: "การเชื่อมต่อ",
    title: "ทำงานร่วมกับเครื่องมือและเอเจนต์ที่คุณใช้อยู่แล้ว",
    description:
      "PromptConnext ประสานงานสแตกที่คุณมีอยู่แทนที่จะแทนที่มัน ใช้เอเจนต์เขียนโค้ด โมเดล และตัวติดตามงานของคุณเอง",
    sections: [
      {
        heading: "เอเจนต์เขียนโค้ด",
        body: "Claude Code (ส่งไปยังโมเดลที่คุณเชื่อมต่อ), Gemini CLI, Codex CLI หรือเอเจนต์ CLI ที่กำหนดเอง หากไม่มีเอเจนต์ติดตั้งไว้ ตัวสร้างแบบครั้งเดียวในตัวจะรันบนโมเดลเขียนโค้ดที่เชื่อมต่อไว้",
      },
      {
        heading: "โมเดลและเอนด์พอยต์",
        body: "OpenAI, Anthropic, Google, OpenRouter และเอนด์พอยต์ใดก็ตามที่เข้ากันได้กับ OpenAI — รวมถึง Ollama และ vLLM ในเครื่องสำหรับการประมวลผลแบบส่วนตัวล้วน",
      },
      {
        heading: "ตัวติดตามงานและเครื่องมือ",
        body: "การซิงก์สถานะสองทางกับ Jira และ ClickUp ทำให้ฟิลด์ฝั่ง PMO สอดคล้องกัน ขณะที่กราฟแบบ AI-native ยังเป็นแหล่งอ้างอิงหลักสำหรับการรันเอเจนต์และการตรวจสอบย้อนกลับ ขยายเพิ่มได้ด้วยเซิร์ฟเวอร์ MCP",
      },
    ],
  },
];

const byLocale: Record<Locale, ProductPage[]> = { en, th };

export function getProductPages(locale: Locale): ProductPage[] {
  return byLocale[locale];
}

export function getProductPage(locale: Locale, slug: string): ProductPage | undefined {
  return byLocale[locale].find((p) => p.slug === slug);
}

export function getProductSlugs(): string[] {
  return en.map((p) => p.slug);
}

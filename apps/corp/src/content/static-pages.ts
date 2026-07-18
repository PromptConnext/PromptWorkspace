/**
 * Locale-keyed content for the prose marketing pages (Download body, Docs,
 * Getting Started, About, Contact, Legal). Rendered by the pages under
 * src/app/[locale]/. Add a language by extending each record.
 */
import type { Locale } from "@/i18n/routing";

type Section = { heading: string; body: string[] };

export type DownloadContent = {
  eyebrow: string;
  title: string;
  description: string;
  stepsTitle: string;
  steps: { title: string; description: string }[];
};

export type DocsHubContent = {
  eyebrow: string;
  title: string;
  description: string;
  cards: { href: string; title: string; description: string }[];
};

export type GettingStartedContent = {
  eyebrow: string;
  title: string;
  description: string;
  sections: Section[];
  note: string;
};

export type AboutContent = {
  eyebrow: string;
  title: string;
  description: string;
  sections: Section[];
};

export type ContactContent = { eyebrow: string; title: string; description: string };

export type LegalContent = {
  eyebrow: string;
  title: string;
  updated: string;
  intro: string;
  sections: Section[];
};

type Bundle = {
  download: DownloadContent;
  docs: DocsHubContent;
  gettingStarted: GettingStartedContent;
  about: AboutContent;
  contact: ContactContent;
  contactSales: ContactContent;
  privacy: LegalContent;
  terms: LegalContent;
};

const en: Bundle = {
  download: {
    eyebrow: "Download",
    title: "Get PromptConnext free",
    description:
      "The desktop app is free and runs on macOS, Windows, and Linux. Your code and model keys stay on your machine.",
    stepsTitle: "What happens after you install",
    steps: [
      { title: "1. Install", description: "Download and open PromptConnext. No account required to get started." },
      {
        title: "2. Connect a model",
        description:
          "Onboarding guides you to connect and health-check one model — use an API key or the free local Ollama path.",
      },
      {
        title: "3. Ship your first project",
        description: "Create a project and move through Scope → Spec → Skill to running code.",
      },
    ],
  },
  docs: {
    eyebrow: "Docs",
    title: "Documentation",
    description: "Everything you need to install PromptConnext and build your first project.",
    cards: [
      {
        href: "/docs/getting-started",
        title: "Getting Started",
        description: "Install PromptConnext, connect your first model, and ship a project end to end.",
      },
      {
        href: "/docs/getting-started",
        title: "Connect a model",
        description: "Use an API key or the free local Ollama path, then health-check it.",
      },
      {
        href: "/product/3s-workflow",
        title: "The 3S workflow",
        description: "Understand Scope → Spec → Skill and the approval gates between them.",
      },
    ],
  },
  gettingStarted: {
    eyebrow: "Docs",
    title: "Getting started",
    description: "From install to your first shipped project in a few steps.",
    sections: [
      {
        heading: "1. Install the app",
        body: [
          "Download PromptConnext for macOS, Windows, or Linux from the download page and open it. No account is required to start.",
        ],
      },
      {
        heading: "2. Connect a model",
        body: [
          "On first run, onboarding guides you to connect and health-check at least one working model. You have two options:",
          "API key / endpoint — paste a key or an OpenAI-compatible base URL (OpenAI, Anthropic, Google, OpenRouter, and more).",
          "Local, zero cost — install Ollama, pull a model such as qwen3:8b, and select “Local Ollama.”",
        ],
      },
      {
        heading: "3. Create a project",
        body: [
          "Start a new project and describe what you want to build in plain language. This is the Scope stage — PromptConnext generates a structured specification for you.",
        ],
      },
      {
        heading: "4. Review the spec, then build",
        body: [
          "Approve the generated plan in the Spec stage. Then, in Skill, connect a coding model or agent (Claude Code, Gemini CLI, or a custom agent) and let implementation proceed — every step traceable in the task graph.",
        ],
      },
    ],
    note: "Your code and model keys never leave your machine. Only the shared task graph syncs to the cloud, and only when you choose to collaborate.",
  },
  about: {
    eyebrow: "About",
    title: "Software delivery, transparent end to end",
    description:
      "We believe business intent and technical execution should live in one AI-orchestrated workspace — visible to everyone who has a stake in the outcome.",
    sections: [
      {
        heading: "Our thesis",
        body: [
          "Most teams lose the thread between what the business asked for and what engineering shipped. PromptConnext keeps that thread intact: every requirement, spec, task, artifact, and AI agent run lives in one traceable graph, so no one has to guess how a product got built.",
        ],
      },
      {
        heading: "Bring your own model",
        body: [
          "We are deliberately not a proprietary model. PromptConnext is the orchestration layer that makes the AI a team already pays for work together across the software lifecycle — cloud or local, with no model tax. That keeps you in control of cost, capability, and privacy.",
        ],
      },
      {
        heading: "One workspace, two personas",
        body: [
          "A business analyst writing requirements and a developer shipping code should not feel like they are in different products. The 3S workflow — Scope, Spec, Skill — is the shared spine that keeps both audiences in one coherent tool.",
        ],
      },
      {
        heading: "Built for the region, open to the world",
        body: [
          "PromptConnext is built with Southeast Asian teams in mind, including first-class support for local languages and local models, while remaining useful to any team, anywhere.",
        ],
      },
    ],
  },
  contact: {
    eyebrow: "Contact",
    title: "Get in touch",
    description:
      "Questions, feedback, or partnership ideas — we’d love to hear from you. For enterprise plans, use the sales form.",
  },
  contactSales: {
    eyebrow: "Enterprise",
    title: "Talk to sales",
    description:
      "Tell us about your team and what you need. We’ll help you roll out shared workspaces, SSO, tracker sync, and support.",
  },
  privacy: {
    eyebrow: "Legal",
    title: "Privacy Policy",
    updated: "Last updated: July 2026",
    intro:
      "This page is a plain-language summary of how PromptConnext handles your data. It is a template and should be reviewed by legal counsel before launch.",
    sections: [
      {
        heading: "What stays on your machine",
        body: [
          "Your source code and model credentials never leave your device. API keys are stored in your operating system’s secure keychain. PromptConnext makes no model calls on your behalf and does not store your code.",
        ],
      },
      {
        heading: "What syncs to the cloud",
        body: [
          "When you choose to collaborate, only the shared task graph — requirements, specs, tasks, artifact metadata, and agent-run records — is synced to your workspace. You control when this happens; nothing syncs automatically without your action.",
        ],
      },
      {
        heading: "Analytics",
        body: [
          "The marketing website may use privacy-respecting analytics that do not use cookies to track you across sites. We collect aggregate usage to improve the product.",
        ],
      },
      {
        heading: "Contact",
        body: ["Questions about privacy? Reach us through the contact page."],
      },
    ],
  },
  terms: {
    eyebrow: "Legal",
    title: "Terms of Service",
    updated: "Last updated: July 2026",
    intro:
      "This page is a template and should be reviewed by legal counsel before launch. By using PromptConnext you agree to the terms below.",
    sections: [
      {
        heading: "Use of the software",
        body: [
          "The PromptConnext desktop application is provided free of charge. You are responsible for the AI models and accounts you connect and for complying with those providers’ terms of service, including any restrictions on programmatic use.",
        ],
      },
      {
        heading: "Your content",
        body: [
          "You retain all rights to your code, projects, and data. PromptConnext claims no ownership over anything you create with it.",
        ],
      },
      {
        heading: "Enterprise plans",
        body: ["Enterprise features are governed by a separate agreement. Contact sales for details."],
      },
      {
        heading: "Disclaimer",
        body: [
          "The software is provided “as is” without warranties of any kind, to the extent permitted by law.",
        ],
      },
    ],
  },
};

const th: Bundle = {
  download: {
    eyebrow: "ดาวน์โหลด",
    title: "รับ PromptConnext ฟรี",
    description:
      "แอปเดสก์ท็อปฟรีและทำงานบน macOS, Windows และ Linux โค้ดและคีย์โมเดลของคุณอยู่บนเครื่องของคุณ",
    stepsTitle: "สิ่งที่เกิดขึ้นหลังติดตั้ง",
    steps: [
      { title: "1. ติดตั้ง", description: "ดาวน์โหลดและเปิด PromptConnext ไม่ต้องมีบัญชีเพื่อเริ่มต้น" },
      {
        title: "2. เชื่อมต่อโมเดล",
        description:
          "การออนบอร์ดจะแนะนำให้คุณเชื่อมต่อและตรวจสุขภาพโมเดลหนึ่งตัว — ใช้คีย์ API หรือเส้นทาง Ollama ในเครื่องแบบฟรี",
      },
      {
        title: "3. ส่งมอบโปรเจกต์แรก",
        description: "สร้างโปรเจกต์และเดินผ่าน Scope → Spec → Skill ไปสู่โค้ดที่ทำงานได้",
      },
    ],
  },
  docs: {
    eyebrow: "เอกสาร",
    title: "เอกสารประกอบ",
    description: "ทุกสิ่งที่คุณต้องใช้ในการติดตั้ง PromptConnext และสร้างโปรเจกต์แรกของคุณ",
    cards: [
      {
        href: "/docs/getting-started",
        title: "เริ่มต้นใช้งาน",
        description: "ติดตั้ง PromptConnext เชื่อมต่อโมเดลแรก และส่งมอบโปรเจกต์ตลอดกระบวนการ",
      },
      {
        href: "/docs/getting-started",
        title: "เชื่อมต่อโมเดล",
        description: "ใช้คีย์ API หรือเส้นทาง Ollama ในเครื่องแบบฟรี แล้วตรวจสุขภาพการเชื่อมต่อ",
      },
      {
        href: "/product/3s-workflow",
        title: "เวิร์กโฟลว์ 3S",
        description: "ทำความเข้าใจ Scope → Spec → Skill และจุดอนุมัติระหว่างขั้นตอน",
      },
    ],
  },
  gettingStarted: {
    eyebrow: "เอกสาร",
    title: "เริ่มต้นใช้งาน",
    description: "จากการติดตั้งไปสู่โปรเจกต์แรกที่ส่งมอบได้ในไม่กี่ขั้นตอน",
    sections: [
      {
        heading: "1. ติดตั้งแอป",
        body: [
          "ดาวน์โหลด PromptConnext สำหรับ macOS, Windows หรือ Linux จากหน้าดาวน์โหลดแล้วเปิดขึ้นมา ไม่ต้องมีบัญชีเพื่อเริ่ม",
        ],
      },
      {
        heading: "2. เชื่อมต่อโมเดล",
        body: [
          "เมื่อเปิดครั้งแรก การออนบอร์ดจะแนะนำให้คุณเชื่อมต่อและตรวจสุขภาพโมเดลที่ใช้งานได้อย่างน้อยหนึ่งตัว คุณมีสองทางเลือก:",
          "คีย์ API / เอนด์พอยต์ — วางคีย์หรือ base URL ที่เข้ากันได้กับ OpenAI (OpenAI, Anthropic, Google, OpenRouter และอื่น ๆ)",
          "ในเครื่อง ไม่มีค่าใช้จ่าย — ติดตั้ง Ollama ดึงโมเดลเช่น qwen3:8b แล้วเลือก “Local Ollama”",
        ],
      },
      {
        heading: "3. สร้างโปรเจกต์",
        body: [
          "เริ่มโปรเจกต์ใหม่และอธิบายสิ่งที่คุณต้องการสร้างด้วยภาษาธรรมดา นี่คือขั้น Scope — PromptConnext สร้างสเปกที่มีโครงสร้างให้คุณ",
        ],
      },
      {
        heading: "4. ตรวจสเปก แล้วสร้าง",
        body: [
          "อนุมัติแผนที่สร้างขึ้นในขั้น Spec จากนั้นในขั้น Skill เชื่อมต่อโมเดลหรือเอเจนต์เขียนโค้ด (Claude Code, Gemini CLI หรือเอเจนต์ที่กำหนดเอง) แล้วปล่อยให้การพัฒนาดำเนินไป — ทุกขั้นตอนตรวจสอบย้อนกลับได้ในกราฟงาน",
        ],
      },
    ],
    note: "โค้ดและคีย์โมเดลของคุณไม่ออกจากเครื่อง มีเพียงกราฟงานที่แชร์เท่านั้นที่ซิงก์ไปยังคลาวด์ และเฉพาะเมื่อคุณเลือกทำงานร่วมกัน",
  },
  about: {
    eyebrow: "เกี่ยวกับเรา",
    title: "การส่งมอบซอฟต์แวร์ที่โปร่งใสตลอดกระบวนการ",
    description:
      "เราเชื่อว่าเจตนาทางธุรกิจและการลงมือทางเทคนิคควรอยู่ในเวิร์กสเปซที่ประสานด้วย AI เดียวกัน — มองเห็นได้สำหรับทุกคนที่มีส่วนได้ส่วนเสียในผลลัพธ์",
    sections: [
      {
        heading: "แนวคิดหลักของเรา",
        body: [
          "ทีมส่วนใหญ่สูญเสียเส้นเชื่อมระหว่างสิ่งที่ธุรกิจร้องขอกับสิ่งที่วิศวกรรมส่งมอบ PromptConnext คงเส้นนั้นไว้: ทุกความต้องการ สเปก งาน อาร์ติแฟกต์ และการรันเอเจนต์ AI อยู่ในกราฟที่ตรวจสอบย้อนกลับได้ ไม่มีใครต้องเดาว่าผลิตภัณฑ์ถูกสร้างขึ้นอย่างไร",
        ],
      },
      {
        heading: "ใช้โมเดลของคุณเอง",
        body: [
          "เราตั้งใจไม่เป็นโมเดลกรรมสิทธิ์ PromptConnext คือชั้นประสานงานที่ทำให้ AI ที่ทีมจ่ายอยู่แล้วทำงานร่วมกันตลอดวงจรซอฟต์แวร์ — คลาวด์หรือในเครื่อง โดยไม่มีค่าธรรมเนียมโมเดล คุณจึงควบคุมต้นทุน ความสามารถ และความเป็นส่วนตัวได้เอง",
        ],
      },
      {
        heading: "หนึ่งเวิร์กสเปซ สองบทบาท",
        body: [
          "นักวิเคราะห์ธุรกิจที่เขียนความต้องการและนักพัฒนาที่ส่งมอบโค้ดไม่ควรรู้สึกว่าอยู่คนละผลิตภัณฑ์ เวิร์กโฟลว์ 3S — Scope, Spec, Skill — คือแกนร่วมที่ทำให้ผู้ใช้ทั้งสองกลุ่มอยู่ในเครื่องมือเดียวที่สอดคล้องกัน",
        ],
      },
      {
        heading: "สร้างเพื่อภูมิภาค เปิดสู่โลก",
        body: [
          "PromptConnext ถูกสร้างโดยคำนึงถึงทีมในเอเชียตะวันออกเฉียงใต้ รวมถึงการรองรับภาษาท้องถิ่นและโมเดลในเครื่องอย่างเต็มที่ ในขณะที่ยังมีประโยชน์ต่อทุกทีมทุกที่",
        ],
      },
    ],
  },
  contact: {
    eyebrow: "ติดต่อ",
    title: "ติดต่อเรา",
    description:
      "คำถาม ข้อเสนอแนะ หรือไอเดียความร่วมมือ — เรายินดีรับฟัง สำหรับแพ็กเกจองค์กร กรุณาใช้แบบฟอร์มฝ่ายขาย",
  },
  contactSales: {
    eyebrow: "องค์กร",
    title: "ติดต่อฝ่ายขาย",
    description:
      "บอกเราเกี่ยวกับทีมและสิ่งที่คุณต้องการ เราจะช่วยคุณเริ่มใช้เวิร์กสเปซที่แชร์ SSO การซิงก์ตัวติดตามงาน และการสนับสนุน",
  },
  privacy: {
    eyebrow: "ข้อกฎหมาย",
    title: "นโยบายความเป็นส่วนตัว",
    updated: "อัปเดตล่าสุด: กรกฎาคม 2026",
    intro:
      "หน้านี้เป็นสรุปด้วยภาษาที่เข้าใจง่ายว่า PromptConnext จัดการข้อมูลของคุณอย่างไร เป็นเทมเพลตและควรได้รับการตรวจทานโดยที่ปรึกษากฎหมายก่อนเปิดตัว",
    sections: [
      {
        heading: "สิ่งที่อยู่บนเครื่องของคุณ",
        body: [
          "ซอร์สโค้ดและข้อมูลรับรองโมเดลของคุณไม่ออกจากอุปกรณ์ คีย์ API ถูกเก็บใน keychain ที่ปลอดภัยของระบบปฏิบัติการ PromptConnext ไม่เรียกใช้โมเดลแทนคุณและไม่เก็บโค้ดของคุณ",
        ],
      },
      {
        heading: "สิ่งที่ซิงก์ไปยังคลาวด์",
        body: [
          "เมื่อคุณเลือกทำงานร่วมกัน มีเพียงกราฟงานที่แชร์ — ความต้องการ สเปก งาน เมทาดาทาของอาร์ติแฟกต์ และบันทึกการรันเอเจนต์ — ที่ซิงก์ไปยังเวิร์กสเปซของคุณ คุณควบคุมว่าจะให้เกิดเมื่อใด ไม่มีอะไรซิงก์อัตโนมัติโดยที่คุณไม่ได้สั่ง",
        ],
      },
      {
        heading: "การวิเคราะห์",
        body: [
          "เว็บไซต์การตลาดอาจใช้การวิเคราะห์ที่เคารพความเป็นส่วนตัวซึ่งไม่ใช้คุกกี้ติดตามคุณข้ามเว็บไซต์ เราเก็บข้อมูลการใช้งานแบบรวมเพื่อปรับปรุงผลิตภัณฑ์",
        ],
      },
      {
        heading: "ติดต่อ",
        body: ["มีคำถามเรื่องความเป็นส่วนตัว? ติดต่อเราผ่านหน้าติดต่อ"],
      },
    ],
  },
  terms: {
    eyebrow: "ข้อกฎหมาย",
    title: "ข้อกำหนดการใช้งาน",
    updated: "อัปเดตล่าสุด: กรกฎาคม 2026",
    intro:
      "หน้านี้เป็นเทมเพลตและควรได้รับการตรวจทานโดยที่ปรึกษากฎหมายก่อนเปิดตัว การใช้ PromptConnext ถือว่าคุณยอมรับข้อกำหนดด้านล่าง",
    sections: [
      {
        heading: "การใช้ซอฟต์แวร์",
        body: [
          "แอปเดสก์ท็อป PromptConnext ให้บริการโดยไม่มีค่าใช้จ่าย คุณรับผิดชอบต่อโมเดล AI และบัญชีที่คุณเชื่อมต่อ และการปฏิบัติตามข้อกำหนดการใช้งานของผู้ให้บริการเหล่านั้น รวมถึงข้อจำกัดในการใช้แบบโปรแกรม",
        ],
      },
      {
        heading: "เนื้อหาของคุณ",
        body: [
          "คุณคงสิทธิ์ทั้งหมดในโค้ด โปรเจกต์ และข้อมูลของคุณ PromptConnext ไม่อ้างความเป็นเจ้าของในสิ่งใดที่คุณสร้างด้วยมัน",
        ],
      },
      {
        heading: "แพ็กเกจองค์กร",
        body: ["ฟีเจอร์ระดับองค์กรอยู่ภายใต้ข้อตกลงแยกต่างหาก ติดต่อฝ่ายขายเพื่อดูรายละเอียด"],
      },
      {
        heading: "ข้อจำกัดความรับผิด",
        body: [
          "ซอฟต์แวร์นี้ให้บริการ “ตามสภาพ” โดยไม่มีการรับประกันใด ๆ เท่าที่กฎหมายอนุญาต",
        ],
      },
    ],
  },
};

const byLocale: Record<Locale, Bundle> = { en, th };

export function getStaticPages(locale: Locale): Bundle {
  return byLocale[locale];
}

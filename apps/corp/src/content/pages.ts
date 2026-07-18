import type { Locale } from "@/i18n/routing";

export type PricingTier = {
  name: string;
  price: string;
  tagline: string;
  ctaLabel: string;
  ctaHref: string;
  ctaVariant: "primary" | "secondary";
  features: string[];
};

export type PricingContent = {
  eyebrow: string;
  title: string;
  description: string;
  tiers: PricingTier[];
  faqTitle: string;
  faqs: { question: string; answer: string }[];
};

export type FaqContent = {
  eyebrow: string;
  title: string;
  description: string;
  faqs: { question: string; answer: string }[];
};

const pricing: Record<Locale, PricingContent> = {
  en: {
    eyebrow: "Pricing",
    title: "Free for the desktop app. Enterprise when you need it.",
    description: "No model tax, ever. Start free, and add enterprise collaboration when your team grows.",
    tiers: [
      {
        name: "Free",
        price: "$0",
        tagline: "The full desktop app, forever.",
        ctaLabel: "Download free",
        ctaHref: "/download",
        ctaVariant: "primary",
        features: [
          "Complete 3S workflow (Scope → Spec → Skill)",
          "Bring your own model — cloud or local, no model tax",
          "Local-first task graph with full traceability",
          "Claude Code, Gemini CLI & custom agent orchestration",
          "Local & personal workspaces",
        ],
      },
      {
        name: "Enterprise",
        price: "Custom",
        tagline: "For teams that collaborate at scale.",
        ctaLabel: "Contact sales",
        ctaHref: "/contact/sales",
        ctaVariant: "secondary",
        features: [
          "Everything in Free",
          "Shared cloud workspaces & role-based access",
          "SSO and admin controls",
          "Two-way Jira / ClickUp status sync",
          "Priority support & onboarding",
        ],
      },
    ],
    faqTitle: "Pricing FAQ",
    faqs: [
      {
        question: "Is PromptConnext really free?",
        answer:
          "Yes. The desktop app is free forever. You bring your own model, and you pay your model provider directly — PromptConnext never marks up tokens.",
      },
      {
        question: "What does Enterprise add?",
        answer:
          "Shared cloud workspaces, SSO, role-based access, two-way Jira/ClickUp sync, and priority support. Pricing is tailored to your team — contact sales.",
      },
      {
        question: "Do I need to pay for AI models separately?",
        answer:
          "You connect your own models. Use API keys you already hold, or run a local model with Ollama at zero cost. PromptConnext orchestrates them without any model tax.",
      },
    ],
  },
  th: {
    eyebrow: "ราคา",
    title: "ฟรีสำหรับแอปเดสก์ท็อป และแบบองค์กรเมื่อคุณต้องการ",
    description: "ไม่มีค่าธรรมเนียมโมเดล เริ่มฟรี แล้วเพิ่มการทำงานร่วมกันระดับองค์กรเมื่อทีมของคุณเติบโต",
    tiers: [
      {
        name: "ฟรี",
        price: "฿0",
        tagline: "แอปเดสก์ท็อปครบชุด ตลอดไป",
        ctaLabel: "ดาวน์โหลดฟรี",
        ctaHref: "/download",
        ctaVariant: "primary",
        features: [
          "เวิร์กโฟลว์ 3S ครบถ้วน (Scope → Spec → Skill)",
          "ใช้โมเดลของคุณเอง — คลาวด์หรือในเครื่อง ไม่มีค่าธรรมเนียมโมเดล",
          "กราฟงานแบบ local-first ตรวจสอบย้อนกลับได้เต็มที่",
          "ประสานงาน Claude Code, Gemini CLI และเอเจนต์ที่กำหนดเอง",
          "เวิร์กสเปซในเครื่องและส่วนบุคคล",
        ],
      },
      {
        name: "องค์กร",
        price: "กำหนดเอง",
        tagline: "สำหรับทีมที่ทำงานร่วมกันในระดับใหญ่",
        ctaLabel: "ติดต่อฝ่ายขาย",
        ctaHref: "/contact/sales",
        ctaVariant: "secondary",
        features: [
          "ทุกอย่างในแพ็กเกจฟรี",
          "เวิร์กสเปซคลาวด์ที่แชร์และการเข้าถึงตามบทบาท",
          "SSO และการควบคุมสำหรับผู้ดูแล",
          "การซิงก์สถานะสองทางกับ Jira / ClickUp",
          "การสนับสนุนและการออนบอร์ดแบบมีลำดับความสำคัญ",
        ],
      },
    ],
    faqTitle: "คำถามที่พบบ่อยเรื่องราคา",
    faqs: [
      {
        question: "PromptConnext ฟรีจริงไหม",
        answer:
          "จริง แอปเดสก์ท็อปฟรีตลอดไป คุณใช้โมเดลของคุณเองและจ่ายผู้ให้บริการโมเดลโดยตรง — PromptConnext ไม่บวกค่าโทเคน",
      },
      {
        question: "แพ็กเกจองค์กรเพิ่มอะไรบ้าง",
        answer:
          "เวิร์กสเปซคลาวด์ที่แชร์ SSO การเข้าถึงตามบทบาท การซิงก์สองทางกับ Jira/ClickUp และการสนับสนุนแบบมีลำดับความสำคัญ ราคาปรับตามทีมของคุณ — ติดต่อฝ่ายขาย",
      },
      {
        question: "ต้องจ่ายค่าโมเดล AI แยกต่างหากไหม",
        answer:
          "คุณเชื่อมต่อโมเดลของคุณเอง ใช้คีย์ API ที่คุณมีอยู่แล้ว หรือรันโมเดลในเครื่องด้วย Ollama โดยไม่มีค่าใช้จ่าย PromptConnext ประสานงานให้โดยไม่มีค่าธรรมเนียมโมเดล",
      },
    ],
  },
};

const faq: Record<Locale, FaqContent> = {
  en: {
    eyebrow: "FAQ",
    title: "Frequently asked questions",
    description:
      "Everything you need to know about PromptConnext, bring-your-own-model, privacy, and pricing.",
    faqs: [
      {
        question: "What is PromptConnext?",
        answer:
          "An AI-native development workspace that takes a project from business requirement to running code. It orchestrates the AI models you already pay for, with full transparency across a shared task graph.",
      },
      {
        question: "Which AI models can I use?",
        answer:
          "Any you connect: OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible endpoint, plus local models via Ollama or vLLM. You can also sign in with agentic tools where the provider allows programmatic use.",
      },
      {
        question: "Can I reuse my ChatGPT or Claude subscription?",
        answer:
          "Sometimes. A consumer chat subscription does not automatically include API access, which is billed separately. You can always use API keys you hold, local models at zero cost, or agentic sign-in where supported — PromptConnext names the mode so billing is clear.",
      },
      {
        question: "Is my code or data sent to the cloud?",
        answer:
          "No. Your source code and model keys stay on your machine. When you choose to collaborate, only the shared task graph syncs to the cloud — never your code or credentials.",
      },
      {
        question: "What does it cost?",
        answer:
          "The desktop app is free forever. Enterprise plans add shared cloud workspaces, SSO, Jira/ClickUp sync, and support — contact sales for pricing.",
      },
      {
        question: "Which platforms are supported?",
        answer: "macOS and Windows. Download the desktop app to get started.",
      },
      {
        question: "Do I need to know how to code?",
        answer:
          "No. Business users work in plain language through Scope and Spec. Developers take over at the Skill stage. Both share the same project and progress view.",
      },
    ],
  },
  th: {
    eyebrow: "คำถามที่พบบ่อย",
    title: "คำถามที่พบบ่อย",
    description: "ทุกสิ่งที่คุณต้องรู้เกี่ยวกับ PromptConnext การใช้โมเดลของคุณเอง ความเป็นส่วนตัว และราคา",
    faqs: [
      {
        question: "PromptConnext คืออะไร",
        answer:
          "เวิร์กสเปซพัฒนาซอฟต์แวร์แบบ AI-native ที่พาโปรเจกต์จากความต้องการทางธุรกิจไปสู่โค้ดที่ทำงานได้ มันประสานงานโมเดล AI ที่คุณจ่ายอยู่แล้ว พร้อมความโปร่งใสเต็มที่ผ่านกราฟงานที่ใช้ร่วมกัน",
      },
      {
        question: "ใช้โมเดล AI ใดได้บ้าง",
        answer:
          "โมเดลใดก็ได้ที่คุณเชื่อมต่อ: OpenAI, Anthropic, Google, OpenRouter หรือเอนด์พอยต์ใดก็ตามที่เข้ากันได้กับ OpenAI รวมถึงโมเดลในเครื่องผ่าน Ollama หรือ vLLM คุณยังล็อกอินด้วยเครื่องมือแบบเอเจนต์ได้เมื่อผู้ให้บริการอนุญาตให้ใช้แบบโปรแกรม",
      },
      {
        question: "ใช้การสมัคร ChatGPT หรือ Claude ของฉันซ้ำได้ไหม",
        answer:
          "บางครั้ง การสมัครแชทสำหรับผู้บริโภคไม่รวมการเข้าถึง API โดยอัตโนมัติ ซึ่งคิดเงินแยกต่างหาก คุณใช้คีย์ API ที่คุณถืออยู่ โมเดลในเครื่องแบบไม่มีค่าใช้จ่าย หรือการล็อกอินแบบเอเจนต์เมื่อรองรับได้เสมอ — PromptConnext จะบอกโหมดเพื่อให้ค่าใช้จ่ายชัดเจน",
      },
      {
        question: "โค้ดหรือข้อมูลของฉันถูกส่งไปยังคลาวด์ไหม",
        answer:
          "ไม่ ซอร์สโค้ดและคีย์โมเดลของคุณอยู่บนเครื่องของคุณ เมื่อคุณเลือกทำงานร่วมกัน มีเพียงกราฟงานที่แชร์เท่านั้นที่ซิงก์ไปยังคลาวด์ — ไม่ใช่โค้ดหรือข้อมูลรับรองของคุณ",
      },
      {
        question: "มีค่าใช้จ่ายเท่าไร",
        answer:
          "แอปเดสก์ท็อปฟรีตลอดไป แพ็กเกจองค์กรเพิ่มเวิร์กสเปซคลาวด์ที่แชร์ SSO การซิงก์ Jira/ClickUp และการสนับสนุน — ติดต่อฝ่ายขายเพื่อสอบถามราคา",
      },
      {
        question: "รองรับแพลตฟอร์มใดบ้าง",
        answer: "macOS และ Windows ดาวน์โหลดแอปเดสก์ท็อปเพื่อเริ่มต้น",
      },
      {
        question: "ต้องรู้วิธีเขียนโค้ดไหม",
        answer:
          "ไม่ ผู้ใช้ฝ่ายธุรกิจทำงานด้วยภาษาธรรมดาผ่าน Scope และ Spec นักพัฒนารับช่วงที่ขั้น Skill ทั้งสองใช้โปรเจกต์และมุมมองความคืบหน้าเดียวกัน",
      },
    ],
  },
};

export function getPricingContent(locale: Locale): PricingContent {
  return pricing[locale];
}

export function getFaqContent(locale: Locale): FaqContent {
  return faq[locale];
}

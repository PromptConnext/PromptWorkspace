import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ContactPayload = {
  name?: string;
  email?: string;
  company?: string;
  teamSize?: string;
  message?: string;
  variant?: "general" | "sales";
  // Honeypot: bots fill hidden fields; humans leave it empty.
  website?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: ContactPayload;
  try {
    body = (await request.json()) as ContactPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Spam honeypot — silently accept so bots don't learn.
  if (body.website) {
    return NextResponse.json({ ok: true });
  }

  const name = body.name?.trim() ?? "";
  const email = body.email?.trim() ?? "";
  const message = body.message?.trim() ?? "";

  if (!name || !EMAIL_RE.test(email) || message.length < 5) {
    return NextResponse.json({ ok: false, error: "validation_failed" }, { status: 422 });
  }

  const submission = {
    name,
    email,
    company: body.company?.trim() || undefined,
    teamSize: body.teamSize?.trim() || undefined,
    message,
    variant: body.variant === "sales" ? "sales" : "general",
    receivedAt: new Date().toISOString(),
  };

  // Forward to a webhook/CRM if configured; otherwise just log server-side.
  // Set CONTACT_WEBHOOK_URL (e.g. a Slack/Zapier/HubSpot endpoint) in the env.
  const webhook = process.env.CONTACT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission),
      });
    } catch {
      // Don't fail the user's request if the downstream webhook is down;
      // the submission is still logged below for recovery.
      console.error("[contact] webhook delivery failed", submission.email);
    }
  } else {
    console.log("[contact] submission", submission);
  }

  return NextResponse.json({ ok: true });
}

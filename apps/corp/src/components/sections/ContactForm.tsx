"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

type ContactFormProps = {
  variant?: "general" | "sales";
};

type Status = "idle" | "sending" | "success" | "error";

/**
 * Contact form that POSTs to /api/contact. Configure delivery by setting
 * CONTACT_WEBHOOK_URL in the environment (Slack, Zapier, HubSpot, etc.).
 */
export function ContactForm({ variant = "general" }: ContactFormProps) {
  const t = useTranslations("contactForm");
  const [status, setStatus] = useState<Status>("idle");

  if (status === "success") {
    return (
      <div className="rounded-lg border border-border-default bg-surface-muted p-6 text-sm text-text-secondary">
        {t("success")}
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setStatus("sending");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...data, variant }),
      });
      if (!res.ok) throw new Error("request_failed");
      setStatus("success");
      form.reset();
    } catch {
      setStatus("error");
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
      {/* Honeypot: hidden from users, catches bots. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("name")} name="name" autoComplete="name" required />
        <Field label={t("email")} name="email" type="email" autoComplete="email" required />
      </div>
      {variant === "sales" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("company")} name="company" autoComplete="organization" />
          <Field label={t("teamSize")} name="teamSize" />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="message" className="text-sm font-medium text-text-primary">
          {variant === "sales" ? t("salesMessage") : t("message")}
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          className="rounded-md border border-border-default bg-surface-muted px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-focus-ring"
        />
      </div>

      {status === "error" ? (
        <p role="alert" className="text-sm text-danger">
          {t("error")}
        </p>
      ) : null}

      <div>
        <Button type="submit" size="lg" disabled={status === "sending"}>
          {status === "sending" ? t("sending") : variant === "sales" ? t("submitSales") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium text-text-primary">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        className="h-10 rounded-md border border-border-default bg-surface-muted px-3 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-focus-ring"
      />
    </div>
  );
}

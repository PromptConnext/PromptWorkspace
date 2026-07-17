"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  AuthCard,
  AuthLink,
  AuthLinks,
  Field,
  FormError,
  SubmitButton,
  useStubRedirect,
} from "@/components/auth/ui";

export default function ForgotPasswordPage() {
  const stubRedirecting = useStubRedirect();
  const { sendPasswordReset } = useAuth();

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  if (stubRedirecting) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    try {
      await sendPasswordReset(email);
    } catch {
      // Swallow — never reveal whether the address is registered.
    }
    // Uniform outcome regardless of whether the account exists (no enumeration).
    setSent(true);
  }

  if (sent) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="If an account exists for that address, we've sent a link to reset your password."
      >
        <AuthLinks>
          <span>
            <AuthLink href="/login">Back to sign in</AuthLink>
          </span>
        </AuthLinks>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password" subtitle="Enter your email and we'll send you a reset link.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>Send reset link</SubmitButton>
      </form>
      <AuthLinks>
        <span>
          Remembered it? <AuthLink href="/login">Sign in</AuthLink>
        </span>
      </AuthLinks>
    </AuthCard>
  );
}

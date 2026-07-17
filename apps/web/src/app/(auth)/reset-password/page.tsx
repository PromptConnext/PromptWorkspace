"use client";

import { useRouter } from "next/navigation";
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

export default function ResetPasswordPage() {
  const stubRedirecting = useStubRedirect();
  const { user, loading, updatePassword } = useAuth();
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (stubRedirecting) return null;

  // Supabase parses the recovery token from the email link's URL hash into a
  // session (PASSWORD_RECOVERY). Until that resolves, wait.
  if (loading) {
    return <AuthCard title="Reset your password" subtitle="Loading…" />;
  }

  // No session means the link is missing, expired, or already used. Never show
  // the update form without a valid recovery session.
  if (!user) {
    return (
      <AuthCard
        title="Link expired or invalid"
        subtitle="This password reset link is no longer valid. Request a new one."
      >
        <AuthLinks>
          <span>
            <AuthLink href="/forgot-password">Send a new reset link</AuthLink>
          </span>
        </AuthLinks>
      </AuthCard>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      await updatePassword(password);
      router.replace("/login");
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  return (
    <AuthCard title="Set a new password">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          required
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Re-enter password"
          required
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>Update password</SubmitButton>
      </form>
    </AuthCard>
  );
}

"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
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

function RegisterForm() {
  const stubRedirecting = useStubRedirect();
  const { signUpSupabase } = useAuth();
  const params = useSearchParams();
  const qs = params.toString();
  const loginHref = qs ? `/login?${qs}` : "/login";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (stubRedirecting) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
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
      await signUpSupabase(email, password);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  if (done) {
    return (
      <AuthCard
        title="Check your email"
        subtitle={`We sent a confirmation link to ${email}. Click it to activate your account, then sign in.`}
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
    <AuthCard title="Create your account">
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
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          required
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Re-enter password"
          required
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>Create account</SubmitButton>
      </form>
      <AuthLinks>
        <span>
          Already have an account? <AuthLink href={loginHref}>Sign in</AuthLink>
        </span>
      </AuthLinks>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}

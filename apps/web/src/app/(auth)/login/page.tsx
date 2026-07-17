"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AUTH_MODE } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import { AuthCard, AuthLink, AuthLinks, Field, FormError, SubmitButton } from "@/components/auth/ui";

// Only same-origin, in-app paths are safe redirect targets. Reject absolute
// URLs and protocol-relative paths ("//evil.example") — both would send a
// just-authenticated user off-site.
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function LoginForm() {
  const { user, signInStub, signInSupabase } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));

  const [userId, setUserId] = useState("dev-user");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (user) router.replace(next);
  }, [user, next, router]);

  if (user) return null;

  async function handleStubSubmit(e: React.FormEvent) {
    e.preventDefault();
    signInStub(userId.trim() || "dev-user");
    router.replace(next);
  }

  async function handleSupabaseSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signInSupabase(email, password);
      router.replace(next);
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  }

  if (AUTH_MODE === "stub") {
    return (
      <AuthCard title="Sign in to PromptZone" subtitle="Local dev (stub auth) — any user id works, no password.">
        <form onSubmit={handleStubSubmit} className="flex flex-col gap-4">
          <Field
            label="User id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="user id"
          />
          <SubmitButton>Continue</SubmitButton>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in to PromptZone">
      <form onSubmit={handleSupabaseSubmit} className="flex flex-col gap-4">
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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
        <FormError message={error} />
        <SubmitButton pending={pending}>Sign in</SubmitButton>
      </form>
      <AuthLinks>
        <span>
          No account? <AuthLink href="/register">Create one</AuthLink>
        </span>
        <span>
          <AuthLink href="/forgot-password">Forgot your password?</AuthLink>
        </span>
      </AuthLinks>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

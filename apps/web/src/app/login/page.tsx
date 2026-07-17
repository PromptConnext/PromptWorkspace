"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AUTH_MODE } from "@/lib/config";
import { useAuth } from "@/lib/auth";

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
    try {
      await signInSupabase(email, password);
      router.replace(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-xl font-semibold">Sign in to PromptZone</h1>

      {AUTH_MODE === "stub" ? (
        <form onSubmit={handleStubSubmit} className="flex flex-col gap-3">
          <p className="text-sm text-slate-500">
            Local dev (stub auth) — any user id works, no password.
          </p>
          <input
            className="rounded border border-slate-300 px-3 py-2"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="user id"
          />
          <button className="rounded bg-slate-900 px-3 py-2 text-white" type="submit">
            Continue
          </button>
        </form>
      ) : (
        <form onSubmit={handleSupabaseSubmit} className="flex flex-col gap-3">
          <input
            className="rounded border border-slate-300 px-3 py-2"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
          />
          <input
            className="rounded border border-slate-300 px-3 py-2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button className="rounded bg-slate-900 px-3 py-2 text-white" type="submit">
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

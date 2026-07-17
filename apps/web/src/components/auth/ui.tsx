"use client";

// Shared building blocks for the auth screens under app/(auth). Kept tiny and
// presentational so each page stays focused on its own flow.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AUTH_MODE } from "@/lib/config";

// Passwords don't exist in stub (dev) auth, so register/forgot/reset bounce to
// /login there. Returns true while a redirect is pending — render nothing.
export function useStubRedirect(): boolean {
  const router = useRouter();
  const blocked = AUTH_MODE === "stub";
  useEffect(() => {
    if (blocked) router.replace("/login");
  }, [blocked, router]);
  return blocked;
}

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="w-full">
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        className="rounded-lg border border-slate-300 px-3 py-2 text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
        {...props}
      />
    </label>
  );
}

export function SubmitButton({
  pending,
  children,
}: {
  pending?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Please wait…" : children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="text-sm text-red-600">{message}</p>;
}

export function AuthLinks({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-col gap-1 text-sm text-slate-500">{children}</div>;
}

export function AuthLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-indigo-600 hover:text-indigo-500">
      {children}
    </Link>
  );
}

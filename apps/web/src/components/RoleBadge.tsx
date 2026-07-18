import type { Role } from "@/lib/types";

export function RoleBadge({ role }: { role: Role }) {
  const styles =
    role === "admin"
      ? "bg-slate-900 text-white"
      : "bg-slate-100 text-slate-600";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${styles}`}>
      {role}
    </span>
  );
}

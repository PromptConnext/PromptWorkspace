import { avatarColor, initial } from "@/lib/identity";

export function Avatar({
  identity,
  size = "md",
}: {
  identity: { email: string | null; user_id: string };
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? "h-6 w-6 text-xs" : "h-9 w-9 text-sm";
  return (
    <span
      aria-hidden
      className={`flex ${dims} shrink-0 items-center justify-center rounded-full font-semibold ${avatarColor(identity)}`}
    >
      {initial(identity)}
    </span>
  );
}

import { Avatar } from "@/components/Avatar";
import type { WorkspaceMember } from "@/lib/types";

/**
 * A card is a few hundred pixels wide and an email address is not. Cards show
 * the local part only — `dev-user`, not `dev-user@promptworkspace.local` — with
 * the full address kept in option lists and the hover title, where there is
 * room to disambiguate two people who share a first name.
 *
 * A raw user id is never a name. A member the list doesn't know (left the
 * workspace, or the list failed to load) reads "Unknown member", and a legacy
 * row with no email reads "Unnamed member".
 */
export function memberFullName(member: WorkspaceMember | undefined): string {
  if (!member) return "Unknown member";
  return member.email ?? "Unnamed member";
}

export function memberShortName(member: WorkspaceMember | undefined): string {
  const full = memberFullName(member);
  if (!member?.email) return full;
  const at = full.indexOf("@");
  return at > 0 ? full.slice(0, at) : full;
}

export function MemberChip({
  member,
  title,
}: {
  member: WorkspaceMember | undefined;
  /** Hover text; defaults to the full address. */
  title?: string;
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-xs text-slate-700"
      title={title ?? memberFullName(member)}
    >
      {member ? (
        <Avatar identity={member} size="sm" />
      ) : (
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600"
        >
          ?
        </span>
      )}
      <span className="truncate">{memberShortName(member)}</span>
    </span>
  );
}

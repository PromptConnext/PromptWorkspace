// Shared "who is this" rendering: turns a member's email (or, for legacy rows
// without one, their raw id) into an initial and a stable color — so the
// same person always gets the same avatar across the app.

const AVATAR_COLORS = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700",
  "bg-lime-100 text-lime-700",
  "bg-teal-100 text-teal-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-fuchsia-100 text-fuchsia-700",
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function displayName(identity: { email: string | null; user_id: string }): string {
  return identity.email ?? identity.user_id;
}

export function initial(identity: { email: string | null; user_id: string }): string {
  const source = identity.email ?? identity.user_id;
  return source.charAt(0).toUpperCase();
}

export function avatarColor(identity: { email: string | null; user_id: string }): string {
  const source = identity.email ?? identity.user_id;
  return AVATAR_COLORS[hash(source) % AVATAR_COLORS.length];
}

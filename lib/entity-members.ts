/**
 * Workspace members, shaped for a `user` field (`SSR-000093` / FM-USER).
 *
 * A `user` field's value is a **username**; the reader wants to see a person.
 * The only place that mapping can come from is the base's
 * `list_workspace_members` tool — `get_metadata` declares the type and nothing
 * else, so a member list inferred from metadata or hard-coded here would be a
 * different list from the one the base validates against.
 *
 * Everything in this module is pure shaping of what that tool answered. It never
 * invents a member, never invents a display name, and never treats a display name
 * as a value: `username` is what the form submits (`SSR-000093` ② ⑤).
 */

export interface WorkspaceMember {
  /** The value: what a `user` field holds and what a form submits. */
  username: string;
  /** What the reader sees, or `""` when the base declares none. */
  displayName: string;
  email: string;
  /** The role this row named, when the base reports one. */
  roleName: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The member list from one answer, in a stable order.
 *
 * The tool reports **role assignments**, so one person appears once per role.
 * A `user` field references the person, not the assignment, so rows are merged
 * by `username` — first row wins, because the extra rows only add a role.
 * Order is by username (code units, not locale) so the same answer always draws
 * the same menu on the server and in the browser (`SSR-000093` AC-5 "顺序稳定").
 *
 * An unfamiliar wrapper is accepted (`members` / `items` / `data`) because this
 * parses what a deployment answered, not a shape we control; anything else is an
 * empty list rather than a guess.
 */
export function normalizeMembers(value: unknown): WorkspaceMember[] {
  const record = asRecord(value);
  const raw = Array.isArray(value)
    ? value
    : [record?.members, record?.items, record?.data].find((candidate): candidate is unknown[] => Array.isArray(candidate)) ?? [];

  const byUsername = new Map<string, WorkspaceMember>();
  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;
    const username = text(row.username);
    if (!username) continue;
    const seen = byUsername.get(username);
    if (seen) {
      // Same person, another role: keep the first row's identity and the extra role.
      const roleName = text(row.roleName);
      if (!seen.roleName && roleName) seen.roleName = roleName;
      continue;
    }
    byUsername.set(username, {
      username,
      displayName: text(row.displayName),
      email: text(row.email),
      roleName: text(row.roleName),
    });
  }

  return [...byUsername.values()].sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

/** What the reader sees for a member: the display name when the base declares one. */
export function memberLabel(member: WorkspaceMember): string {
  return member.displayName || member.username;
}

/** The secondary line under a label: the base never puts an email in the value. */
export function memberDetail(member: WorkspaceMember): string {
  return member.email;
}

export function memberOf(members: readonly WorkspaceMember[], username: string): WorkspaceMember | undefined {
  return members.find((member) => member.username === username);
}

/**
 * A stored value as the usernames it addresses.
 *
 * A single-value field is a string; a multi-value field is an array. Both shapes
 * appear in the wild (a value written before the field was narrowed), so reading
 * accepts either and never joins them into one string — collapsing `["a","b"]`
 * into `"a、b"` would turn two references into a username nobody has.
 */
export function userValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const username = item.trim();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    values.push(username);
  }
  return values;
}

/** Usernames the field holds that the member list does not know (`SSR-000093` ③). */
export function unknownMembers(values: readonly string[], members: readonly WorkspaceMember[]): string[] {
  const known = new Set(members.map((member) => member.username));
  return values.filter((username) => !known.has(username));
}

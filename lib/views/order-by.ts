/**
 * Is a view's `orderBy` a field the type actually declares?
 *
 * `list` answers a bad sort key with an error, so the query "works" — but it
 * costs a round trip and returns it as a failed view, which reads the same as
 * "the data is unavailable" (`SSR-000066` AC-2). The panel can answer this
 * before it asks: the type's field list is one `get_metadata` away.
 *
 * `orderBy` may be one key or a list of them (`SSR-000066` rev20). Every key is
 * checked, and a refusal names the one that failed — reporting "one of your keys
 * is wrong" would leave the author to guess which.
 *
 * Two rules keep the check from doing harm:
 * - **Fail open.** No type in the DQL, an unreachable server, unusable
 *   metadata — the check abstains, and `list` gets the last word. A metadata
 *   hiccup must never turn a working view into a broken one.
 * - **Which types are sortable is not decided here.** That is DAT-SORT's
 *   contract (`SSR-000055`); this only answers "does the field exist".
 */

/**
 * Fields the engine sorts on without them being declared per type — the same
 * list the query language accepts as system fields.
 */
export const SYSTEM_SORT_FIELDS = [
  "id",
  "key",
  "type",
  "state",
  "revision",
  "name",
  "description",
  "createdAt",
  "createdBy",
  "modifiedAt",
  "modifiedBy",
  "workspaceId",
] as const;

/**
 * A spelling-insensitive key: `modified_at`, `modifiedAt` and `modified-at`
 * are one field. The base accepts both snake_case and camelCase, so a check
 * that insisted on one of them would reject working configuration.
 */
export function sortFieldKey(name: string): string {
  return name.replace(/[_-]/g, "").toLowerCase();
}

/** Field names a type declares, or null when the metadata cannot be used. */
export function declaredSortFields(metadata: unknown): string[] | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const fields = (metadata as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  const names: string[] = [];
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const name = (field as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names.length > 0 ? names : null;
}

export type OrderByVerdict = { ok: true } | { ok: false; error: string };

/** The configured keys, in order; empty when the view does not sort. */
export function orderByKeys(orderBy: string | string[] | null): string[] {
  if (!orderBy) return [];
  return Array.isArray(orderBy) ? orderBy : [orderBy];
}

/**
 * Whether `orderBy` names something this type can be sorted by.
 *
 * @param orderBy the configured key, a list of keys, or null when the view does not sort
 * @param declared the type's own field names, or null when unknown (abstain)
 */
export function checkOrderBy(
  orderBy: string | string[] | null,
  declared: string[] | null,
): OrderByVerdict {
  const keys = orderByKeys(orderBy);
  if (keys.length === 0) return { ok: true };
  if (!declared) return { ok: true };

  const known = new Set<string>([...SYSTEM_SORT_FIELDS.map(sortFieldKey), ...declared.map(sortFieldKey)]);

  // Name what exists, not just what does not: the fix is usually a typo, and the
  // list is short enough to read in the panel's error line.
  const available = [...new Set([...declared, ...SYSTEM_SORT_FIELDS])].sort();
  const multiple = Array.isArray(orderBy);

  for (const [index, key] of keys.entries()) {
    // An empty element is refused while the file is parsed, not here; skipping
    // it keeps this check from reporting a second, unrelated problem.
    if (!key) continue;
    if (known.has(sortFieldKey(key))) continue;
    const where = multiple ? `orderBy 第 ${index + 1} 个键` : "orderBy ";
    return {
      ok: false,
      error: `${where}指向的字段不存在：「${key}」不在该类型的字段里（可用：${available.join("、")}）`,
    };
  }
  return { ok: true };
}

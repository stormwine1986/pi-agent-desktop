/**
 * `watch.fill`: what the pump writes into the fields a state change requires.
 *
 * The pump moves an item into `claim.manual` on someone's behalf, and the entity
 * model may make that move require fields — TASK, for instance, requires
 * `remarks` on IN_PROGRESS → BLOCKED. The pump has no business knowing that
 * field name (the same mechanism serves any entity type), so the view supplies
 * it: **field name → template**, and the pump sends only what the target route
 * actually requires.
 *
 * The intersection is the whole safety story: a template for a field the route
 * no longer requires simply stops travelling, instead of turning into an
 * unexpected write.
 */

/** The placeholders a `watch.fill` template may use. */
export const FILL_PLACEHOLDERS = ["key", "type", "view", "reason", "from", "to"] as const;

export type FillPlaceholder = (typeof FILL_PLACEHOLDERS)[number];

/** What a template is rendered against. Every value is a plain string. */
export interface FillValues {
  /** The entity's key, as the view's row reports it. */
  key: string;
  /** The entity's type, from the row the pump read. */
  type: string;
  /** The view title — the same name the panel and the session title show. */
  view: string;
  /** Why the pump is parking the item: `timeout` or `failed`. */
  reason: string;
  /** The claim state the item is leaving. */
  from: string;
  /** The manual state the item is entering. */
  to: string;
}

/** `{{name}}` occurrences in a template, in order, without duplicates. */
export function placeholdersIn(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Placeholders a template uses that `watch.fill` does not provide. */
export function unknownPlaceholders(template: string): string[] {
  return placeholdersIn(template).filter(
    (name) => !(FILL_PLACEHOLDERS as readonly string[]).includes(name),
  );
}

/**
 * The required fields `fill` has no template for.
 *
 * This is a configuration error, not a runtime one: the pump cannot invent the
 * field's content, so a view that does not cover it can never park an item — and
 * a row that cannot be parked stays in the claimed state, out of the view, with
 * nothing to show for it. Named individually so the author knows what to add.
 */
export function missingFillFields(
  fill: Record<string, string>,
  requiredFields: readonly string[],
): string[] {
  const configured = new Set(Object.keys(fill));
  return requiredFields.filter((field) => !configured.has(field));
}

/** `{{name}}` substitution; unknown placeholders are left as written, so a typo stays visible. */
export function renderFill(template: string, values: FillValues): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name as keyof FillValues]) : whole,
  );
}

/**
 * The `fields` a promotion carries: every required field the view configured,
 * rendered, and nothing else.
 *
 * Empty object when the route requires nothing — the caller then sends no
 * `fields` at all, which is byte for byte what it did before this existed.
 */
export function resolveFill(
  fill: Record<string, string>,
  requiredFields: readonly string[],
  values: FillValues,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of requiredFields) {
    const template = fill[field];
    if (template === undefined) continue;
    fields[field] = renderFill(template, values);
  }
  return fields;
}

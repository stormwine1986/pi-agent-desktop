/**
 * Who may write which field, computed from the base's own rules.
 *
 * The panel must not invent its own notion of permission: it reads the type
 * definition and this reader's roles, then applies exactly the rules the base
 * documents (`docs/RBAC_DECISION_RULES.md` §二, §三 gate 3). Two consequences
 * worth keeping in view:
 *
 * - an empty list, a missing list, or `*` means "no restriction", not "nobody";
 * - a field's `write` map is keyed by state, and a missing state means the
 *   field is not writable there — it does not inherit another state's entry.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Whether a permission list lets one of these roles through. */
export function allows(list: string[] | undefined, roles: string[]): boolean {
  if (!list || list.length === 0) return true;
  if (list.some((entry) => entry === "*")) return true;
  const held = new Set(roles.map((role) => role.toUpperCase()));
  return list.some((entry) => held.has(entry.toUpperCase()));
}

/** The roles this identity holds in one workspace, as `about_me` reports them. */
export function rolesIn(value: unknown, workspace: string): string[] {
  const me = asRecord(value);
  if (!me) return [];
  const roles = new Set(asStrings(me.globalRoles));
  const spaces = Array.isArray(me.workspaceRoles) ? me.workspaceRoles : [];
  for (const space of spaces) {
    const record = asRecord(space);
    if (!record || record.id !== workspace) continue;
    for (const role of asStrings(record.roles)) roles.add(role);
  }
  return [...roles];
}

/**
 * Fields this reader may change in `state`.
 *
 * The type-level `write` list is checked first (a reader outside it writes
 * nothing, whatever the fields say); `state` itself is never editable here,
 * because moving between states is a route, not a field.
 */
export function writableFieldsOf(metadata: unknown, state: string, roles: string[]): string[] {
  const definition = asRecord(metadata);
  if (!definition) return [];

  const typePermissions = asRecord(definition.permissions);
  if (typePermissions && !allows(asStrings(typePermissions.write), roles)) return [];

  const fields = Array.isArray(definition.fields) ? definition.fields : [];
  const writable: string[] = [];
  for (const entry of fields) {
    const field = asRecord(entry);
    const name = typeof field?.name === "string" ? field.name : "";
    // `state` is marked by its type, not by its name: the base gives it
    // `type: "state"` and no permissions, because it moves by route.
    if (!name || name === "state" || field?.type === "state") continue;

    const permissions = asRecord(field?.permissions);
    const write = permissions?.write;
    if (write === undefined) {
      writable.push(name);
      continue;
    }
    if (Array.isArray(write)) {
      if (allows(asStrings(write), roles)) writable.push(name);
      continue;
    }
    const byState = asRecord(write);
    const forState = byState?.[state];
    if (Array.isArray(forState) && allows(asStrings(forState), roles)) writable.push(name);
  }
  return writable;
}

/** One transition this reader may take from the entity's current state. */
export interface AvailableRoute {
  name: string;
  to: string;
  /**
   * Fields that must carry a value before the transition is accepted: the
   * route's own list plus everything the destination state requires. The base
   * checks required fields against the *target* state, so the panel asks for
   * the union rather than one of the two lists.
   */
  required: string[];
}

/**
 * Transitions open to this reader right now.
 *
 * Routes come from the type definition, never from the client: a route the
 * model does not declare cannot be offered (`FM-SUBMIT` ⑥), and one whose
 * `permissions` exclude this reader is not offered either.
 */
export function availableRoutesOf(metadata: unknown, state: string, roles: string[]): AvailableRoute[] {
  const definition = asRecord(metadata);
  if (!definition) return [];
  const lifecycle = asRecord(definition.lifecycle);
  const routes = Array.isArray(lifecycle?.routes) ? lifecycle.routes : [];
  const validity = asRecord(definition.validityRules);
  const stateRequired = asRecord(validity?.stateRequiredFields);

  const offers: AvailableRoute[] = [];
  for (const entry of routes) {
    const route = asRecord(entry);
    if (!route || route.from !== state) continue;
    if (!allows(asStrings(route.permissions), roles)) continue;
    const to = typeof route.to === "string" ? route.to : "";
    if (!to) continue;
    const required = new Set<string>(asStrings(route.requiredFields));
    for (const name of asStrings(stateRequired?.[to])) required.add(name);
    offers.push({
      name: typeof route.name === "string" ? route.name : to,
      to,
      required: [...required],
    });
  }
  return offers;
}

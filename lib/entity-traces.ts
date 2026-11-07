/**
 * One hop of traceability, as the base reports it.
 *
 * The base embeds both ends of every link; the row worth showing is the end
 * that is *not* this entity. Direction is the base's own reading — never
 * inferred from a link type's name, which a customer's model is free to extend.
 */

export interface RelationRow {
  key: string;
  type: string;
  name: string;
  state: string;
  /** The relation as named by the side that owns the link. */
  linkType: string;
  /** The same relation named from this entity's side; used when reading downstream. */
  inverseLinkType: string;
  direction: "upstream" | "downstream";
  /** Whether this reader may remove the link — filled in by the route, which holds the roles. */
  canUnlink: boolean;
}

export interface TracesResponse {
  upstream: RelationRow[];
  downstream: RelationRow[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rowOf(
  entity: Record<string, unknown> | undefined,
  link: Record<string, unknown>,
  direction: "upstream" | "downstream",
): RelationRow | null {
  const key = text(entity?.key);
  if (!key) return null;
  return {
    key,
    type: text(entity?.type),
    name: text(entity?.name),
    state: text(entity?.state),
    linkType: text(link.linkType),
    inverseLinkType: text(link.inverseLinkType),
    direction,
    canUnlink: false,
  };
}

/**
 * Splits `list_traces` output into the two directions, dropping what a reader
 * must not see: deleted links (`isActive: false`) and self-links.
 *
 * The base embeds only the far end: an upstream link carries `targetEntity`
 * and no `sourceEntity` (the source is the entity asked about), a downstream
 * link the other way round. Picking the far end by "not this entity" alone
 * therefore drops every upstream row — it must fall back to whichever end is
 * embedded.
 */
export function normalizeTraces(links: unknown[], selfKey: string): TracesResponse {
  const response: TracesResponse = { upstream: [], downstream: [] };
  for (const entry of links) {
    const link = asRecord(entry);
    if (!link || link.isActive === false) continue;

    const source = asRecord(link.sourceEntity);
    const target = asRecord(link.targetEntity);
    const sourceIsSelf = text(source?.key) === selfKey;
    const targetIsSelf = text(target?.key) === selfKey;
    const other = source && !sourceIsSelf ? source : target ?? source;
    if (!other) continue;

    const named = text(link.direction);
    const direction = named === "upstream" || named === "downstream"
      ? named
      // Direction the base did not state: the end it kept tells us which side
      // this entity is on, without reading the relation's name. Only the far
      // end is embedded, so "only a target" means this entity is the source.
      : source && target
        ? sourceIsSelf ? "upstream" : targetIsSelf ? "downstream" : null
        : target ? "upstream" : source ? "downstream" : null;
    if (!direction) continue;

    const row = rowOf(other, link, direction);
    if (!row || row.key === selfKey) continue;
    response[direction].push(row);
  }
  return response;
}

/**
 * Entities carried into a conversation from the to-do views.
 *
 * The entity itself is **not** copied into the message: only a pointer (server,
 * workspace, key) travels with the text, together with an instruction to read
 * the current values through whatever entity tool the session has. Everything
 * the user sees in the conversation then comes from the entity, not from a
 * snapshot taken when the row was clicked.
 *
 * The block names **no channel**: not the server, not the tool. A session may
 * reach the same entity through a differently named server — pi writes a
 * configured `-` as `_`, a view may carry an alias, and a project may point at
 * another stack entirely — so a literal `mcp__<server>__get` in the transcript
 * is at best noise and at worst an instruction to call a tool that does not
 * exist in this session (it made one conversation report "no such server" for
 * an entity it could read perfectly well). The pointer itself keeps the server,
 * because deduplication and the panel need it; the reader never sees it.
 *
 * The block is plain message text — same as `<attached_file>` — so it works in
 * a running session, in a brand-new one, and after a reload, with no server
 * side plumbing.
 */

export interface EntityContextRef {
  /** MCP server name from `mcp.json`; used to identify and open the entity, never printed. */
  server: string;
  /** Workspace the entity lives in; printed, because it disambiguates identical keys. */
  workspace: string;
  key: string;
  name?: string;
  state?: string;
}

/** Identity of a carried entity: one per server + key, so the same row cannot be added twice. */
export function entityRefId(ref: EntityContextRef): string {
  return `${ref.server}:${ref.key}`;
}

function describe(ref: EntityContextRef): string {
  const title = ref.name ? `《${ref.name}》` : "";
  const state = ref.state ? ` ${ref.state}` : "";
  const space = ref.workspace ? `（空间 ${ref.workspace}）` : "";
  return `${ref.key}${title}${state}${space}`;
}

/**
 * The block appended to the user's message. Written as readable text rather
 * than XML: it stays in the transcript, so it has to be legible there too.
 *
 * How to read it is described by the tool's own contract, not by a name we
 * assemble here: a single-entity read takes only `id`, whose schema is
 * `additionalProperties: false`, so an example carrying `workspaceId` would
 * make the first call fail. The workspace is therefore stated as text, not as
 * an argument.
 */
export function formatEntityContextBlock(refs: EntityContextRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((ref) => `· ${describe(ref)}`);
  return [
    "",
    "—— 带入上下文（引用，不是副本）——",
    ...lines,
    "字段与状态以实体当前值为准：用本会话里可用的实体工具按上面的 key 现读（读单条只传 id，不要附带 workspaceId），"
      + "不要以本段文字或历史消息里的旧值为据。本会话没有可用的实体工具时直说，不要凭印象作答。",
  ].join("\n");
}

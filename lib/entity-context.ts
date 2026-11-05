/**
 * Entities carried into a conversation from the to-do views.
 *
 * The entity itself is **not** copied into the message: only a pointer (server,
 * workspace, key) travels with the text, together with an instruction to read
 * the current values through the MCP tool. Everything the user sees in the
 * conversation then comes from the entity, not from a snapshot taken when the
 * row was clicked.
 *
 * The block is plain message text — same as `<attached_file>` — so it works in
 * a running session, in a brand-new one, and after a reload, with no server
 * side plumbing.
 */

export interface EntityContextRef {
  /** MCP server name from `mcp.json`, i.e. the `<server>` in `mcp__<server>__<tool>`. */
  server: string;
  /** Workspace the entity lives in; `list`/`get` take it as a parameter. */
  workspace: string;
  key: string;
  name?: string;
  state?: string;
}

/** Identity of a carried entity: one per server + key, so the same row cannot be added twice. */
export function entityRefId(ref: EntityContextRef): string {
  return `${ref.server}:${ref.key}`;
}

/** The tool name pi registers for an MCP tool, e.g. `mcp__entity-base__get`. */
export function entityToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
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
 * The `get` call takes only `id` — its schema is `additionalProperties: false`,
 * so an example carrying `workspaceId` would make the first call fail. The
 * workspace is therefore stated as text, not as an argument.
 */
export function formatEntityContextBlock(refs: EntityContextRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((ref) => {
    const tool = entityToolName(ref.server, "get");
    return `· ${describe(ref)} — 读取：${tool} {"id":"${ref.key}"}`;
  });
  return [
    "",
    "—— 带入上下文（引用，不是副本）——",
    ...lines,
    "字段与状态以实体当前值为准：先用上面的工具现读，不要以本段文字或历史消息里的旧值为据。",
  ].join("\n");
}

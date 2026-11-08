/**
 * How a server name from a conversation compares with the name in `mcp.json`.
 *
 * pi registers an MCP server's tools as `mcp__<name>__<tool>` with `-` written
 * as `_` (`mcpNamespace()` in `lib/mcp-config-read.ts`). Everything the model
 * sees — and therefore every `entity-item:` link it writes, and every tool name
 * a session event reports — carries that spelling, while `mcp.json` keeps the
 * configured one: `entity_demo_system_evan` and `entity-demo-system-evan` are
 * the same server. Comparing the two literally made a reply's link unopenable
 * and left a to-do view unaware of the write that had just changed it.
 *
 * Client-safe on purpose: the panel and the link parser both need it, and
 * `lib/mcp-call.ts` (which reads `mcp.json`) is server-only.
 */
export function mcpServerKey(name: string): string {
  return name.replace(/-/g, "_").toLowerCase();
}

/** Whether two spellings name the same configured server. */
export function sameMcpServer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return mcpServerKey(a) === mcpServerKey(b);
}

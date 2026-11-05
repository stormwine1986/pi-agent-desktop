/**
 * "An MCP write just happened" — the signal the to-do views subscribe to.
 *
 * A view is a query result (SSR-000067), so it only changes when it is
 * re-evaluated. Polling covers changes made elsewhere, but a write this app
 * just performed is not a guess: the assistant's tool call ended here, so the
 * panel can re-evaluate right away instead of waiting out the poll interval.
 *
 * Kept out of React on purpose: the notification is produced deep inside the
 * session event handler and consumed by a panel that may not be mounted.
 */

/** Tools that only read. Everything else may have changed an entity. */
const READ_ONLY_TOOL = /^(get|list|inspect|recall|show|about|search|describe|resolve)(_|$)|_diff$|_subgraph$/;

const listeners = new Set<(server: string) => void>();
/** Servers written to since the timer started, so a burst of writes costs one refresh. */
const dirtyServers = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 800;

/**
 * `mcp__<server>__<tool>` → `{ server, tool }`. The server name itself may
 * contain dashes but not the double underscore, so the first separator wins and
 * the rest belongs to the tool.
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/** Whether this tool call could have changed an entity. */
export function isEntityWriteTool(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return false;
  return !READ_ONLY_TOOL.test(parsed.tool);
}

/**
 * Called when a tool call finished. Announcing a server is all it does — the
 * subscriber decides which of its views read that server.
 */
export function noteToolFinished(toolName: string): void {
  const parsed = parseMcpToolName(toolName);
  if (!parsed || !isEntityWriteTool(toolName)) return;
  dirtyServers.add(parsed.server);
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const servers = [...dirtyServers];
    dirtyServers.clear();
    for (const server of servers) {
      for (const listener of listeners) listener(server);
    }
  }, FLUSH_DELAY_MS);
}

/** Returns the unsubscribe function. */
export function subscribeEntityWrites(listener: (server: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

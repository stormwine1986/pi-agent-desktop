import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { EVENTS_CONFIG_RELATIVE_PATHS } from "./config";

/**
 * Session deleted → its subscriptions end (SSR-000097【生命周期】, AC-12).
 *
 * Deleting a session removes its entry from the project's `.pi/events.yaml`, so
 * the file does not keep pointing at something that no longer exists. A
 * `sessionId` that was *typed* into the file and never existed is a different
 * case: that one is reported ("会话不存在") and the file is left exactly as the
 * user wrote it — no silent rewrite of intent.
 *
 * Rewriting goes through js-yaml, which drops comments. That is the price of
 * editing YAML without a parser-based editor; it happens only when a matching
 * entry is actually removed.
 */
export function removeSessionSubscriptions(cwd: string, sessionIds: Iterable<string>): boolean {
  const removed = new Set(sessionIds);
  if (removed.size === 0) return false;

  for (const relative of EVENTS_CONFIG_RELATIVE_PATHS) {
    const path = join(cwd, relative);
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      parsed = loadYaml(readFileSync(path, "utf8"));
    } catch {
      // A file that does not parse cannot be edited safely; the runtime already
      // reports it. Leave it alone.
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const root = parsed as Record<string, unknown>;
    if (!Array.isArray(root.sessions)) return false;

    const remaining = root.sessions.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return true;
      const sessionId = (entry as Record<string, unknown>).sessionId;
      return !(typeof sessionId === "string" && removed.has(sessionId));
    });
    if (remaining.length === root.sessions.length) return false;

    const next = { ...root, sessions: remaining };
    try {
      writePrivateFileAtomicSync(path, dumpYaml(next, { lineWidth: -1, noRefs: true }));
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

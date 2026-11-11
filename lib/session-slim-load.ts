import { readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  loadSlimSessionEntries,
  SLIM_LOAD_MAX_FILE_BYTES,
  SLIM_LOAD_MIN_FILE_BYTES,
  type RawEntry,
} from "./session-slim-entries";

// The SessionManager half of the slim loader (see ./session-slim-entries for
// the parsing, which is SDK-free): building a read-only manager over entries
// that never decoded a dead `details` payload.

export { loadSlimSessionEntries, SLIM_LOAD_MIN_FILE_BYTES };

type SessionManagerCtor = new (
  cwd: string,
  sessionDir: string,
  sessionFile: string,
  persist: boolean,
  newSessionOptions: undefined,
  preloadedFileEntries: RawEntry[],
) => SessionManager;

/**
 * A read-only SessionManager for `filePath` built from slimmed entries, or
 * undefined when the file is not a good fit (small, huge, no valid header, or
 * the SDK constructor changed shape) — callers then use `SessionManager.open`.
 */
export function openSlimSessionManager(filePath: string): SessionManager | undefined {
  try {
    const resolved = resolve(filePath);
    const { size } = statSync(resolved);
    if (size < SLIM_LOAD_MIN_FILE_BYTES || size > SLIM_LOAD_MAX_FILE_BYTES) return undefined;

    const entries = loadSlimSessionEntries(readFileSync(resolved));
    const header = entries[0];
    if (!header || header.type !== "session" || typeof header.id !== "string") return undefined;

    // persist=false: the manager can never rewrite or append to the real file.
    // The constructor is private in the typings but public at runtime;
    // session-slim-load.test.mjs pins this against SessionManager.open().
    const Ctor = SessionManager as unknown as SessionManagerCtor;
    const cwd = typeof header.cwd === "string" ? header.cwd : process.cwd();
    return new Ctor(cwd, dirname(resolved), resolved, false, undefined, entries);
  } catch {
    return undefined;
  }
}

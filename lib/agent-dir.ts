import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { userHome } from "./user-home.ts";

/** pi's config directory name, from the SDK's package metadata (`piConfig.configDir`). */
const CONFIG_DIR_NAME = ".pi";

/**
 * The pi agent directory (`~/.pi/agent`), resolved without loading the pi SDK.
 *
 * The value is pi's own `getAgentDir()`. The difference is the price of asking
 * for it: `@earendil-works/pi-coding-agent` is server-external, so its root
 * import loads a 37 MB ESM graph — measured at 1.4–2.3 s of synchronous module
 * loading inside the packaged Node. Next calls `register()` from the
 * instrumentation hook as soon as the server is listening, and the desktop
 * shell does not create its window until its identity probe has been answered
 * (`src-tauri/src/lib.rs`), so a single path lookup in that graph used to sit
 * in front of every cold start (DEFECT-000090, TASK-000108).
 *
 * Anything on the startup path therefore resolves paths here, and reaches for
 * the SDK only when it actually starts a session. `lib/agent-dir.test.mjs`
 * compares this with pi's `getAgentDir()` across the configured shapes pi
 * accepts, so a change on either side fails a test instead of moving the
 * scheduler, the watch pump or the event runtime to another directory.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured) return expandConfiguredDir(configured);
  return join(userHome(), CONFIG_DIR_NAME, "agent");
}

/**
 * pi runs the configured value through `normalizePath()`: Windows shell-style
 * drive paths become native, `~` expands against the home directory, and a
 * `file:` URL becomes its path. Everything else is returned unchanged, which is
 * what lets a relative value stay relative.
 *
 * The one deliberate difference is the home this expands against: `userHome()`
 * honours this fork's `PI_AGENT_HOME` (build-time tracing and relocatable
 * installs), where pi uses `homedir()` directly. With `PI_AGENT_HOME` unset —
 * every packaged start — the two are the same string.
 */
function expandConfiguredDir(value: string): string {
  let normalized = value;
  if (process.platform === "win32" && normalized.startsWith("/") && !normalized.startsWith("//") && !normalized.includes("\\")) {
    const shell = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
    if (shell) normalized = `${shell[1].toUpperCase()}:\\${shell[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  const home = userHome();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

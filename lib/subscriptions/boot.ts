import { existsSync } from "node:fs";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "../artifact-settings";
import { configPathFor } from "./config";
import { ensureRunner } from "./runner";

/**
 * Collection has to start with the server, not with a page: the whole point of
 * a long-lived subscription is that events keep arriving while the tab is
 * closed. The scheduler and the relay are started the same way.
 *
 * Which workspace? The one whose Subscriptions page was last used — the server
 * cannot see the browser's selected project, so the page records it here.
 */
const SETTINGS_KEY = "subscriptionsCwd";

export function rememberSubscriptionsWorkspace(cwd: string): void {
  try {
    const stored = readStored(getPiWebSettingsPath())[SETTINGS_KEY];
    if (stored === cwd) return;
    updatePiWebSettings({ [SETTINGS_KEY]: cwd });
  } catch {
    // A read-only settings dir must not break the page that just loaded.
  }
}

export function startSubscriptionsAtBoot(): void {
  try {
    const stored = readStored(getPiWebSettingsPath())[SETTINGS_KEY];
    if (typeof stored !== "string" || !stored) return;
    if (!existsSync(configPathFor(stored))) return;
    ensureRunner(stored);
  } catch (error) {
    console.error("[subscriptions] could not start:", error instanceof Error ? error.message : error);
  }
}

import type { ProjectTrustStoreEntry } from "@earendil-works/pi-coding-agent";

import { requireSdkModuleSync } from "./pi-sdk-internals";

/**
 * pi's project-trust store, without the package root (TASK-000113).
 *
 * The trust store decides whether a repository's `.pi/extensions`, `.pi/skills`
 * and `.pi/mcp.json` may run or be read, and it is asked on the first screen
 * (`GET /api/project-trust`, which the app fetches while the window is still
 * hidden) and again on every prompt. Importing `ProjectTrustStore` from
 * `@earendil-works/pi-coding-agent` costs the SDK's whole root graph — 1.4 s of
 * blocked loop on the request that happens to load it first — for one small
 * file. The store lives in `dist/core/trust-manager.js` and is loaded from
 * there directly, so the same instance the sessions use answers this read (see
 * `requireSdkModuleSync`). `lib/pi-trust-store.test.mjs` pins that the module's
 * exports match the root's, so an SDK upgrade that moves the file fails a test
 * instead of silently turning trust off.
 */

/** The parts of `dist/core/trust-manager.js` this repository reads. */
export interface PiTrustStoreModule {
  hasTrustRequiringProjectResources(cwd: string): boolean;
  ProjectTrustStore: new (agentDir: string) => {
    get(cwd: string): boolean | null;
    getEntry(cwd: string): ProjectTrustStoreEntry | null;
    set(cwd: string, decision: boolean | null): void;
    setMany(decisions: ReadonlyArray<{ path: string; decision: boolean | null }>): void;
  };
}

export const TRUST_MANAGER_MODULE = "dist/core/trust-manager.js";

// Hot reload and the route/instrumentation module graphs each evaluate this
// module; globalThis keeps one class per process, which is what `instanceof`
// and the store's lock expect.
const TRUST_STORE_KEY: symbol = Symbol.for("pi-web.piTrustStoreModule");

/** The SDK's trust store, loaded on first use and kept for the process. */
export function trustManager(): PiTrustStoreModule {
  const store = globalThis as Record<symbol, PiTrustStoreModule | undefined>;
  return (store[TRUST_STORE_KEY] ??= requireSdkModuleSync<PiTrustStoreModule>(TRUST_MANAGER_MODULE));
}

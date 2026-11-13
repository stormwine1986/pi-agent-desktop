/**
 * "The first screen has been served" — the one signal the background loops wait
 * for before they touch the network or the pi SDK.
 *
 * DEFECT-000104 / TASK-000214. The watch pump used to run its first round
 * immediately (`void tick()`), which lands inside the window the desktop shell
 * waits on: the shell probes `/api/desktop/identity`, the WebView loads `/`, then
 * `/api/custom-css`, then `/api/sessions`, and only then is the window revealed.
 * That first round scanned the whole session catalogue (the same scan
 * `/api/sessions` is about to do) and then pulled the 37 MB pi SDK graph in for
 * `projectBusy` — measured on the packaged payload at `event loop blocked for
 * 2763–3044 ms`, the block crossing the first screen's own requests.
 *
 * Nothing about the pump needs to be that early: a view that waits one more
 * second dispatches the same item one second later. So the pump's first round
 * now waits for this marker plus a short quiet gap, and the *cost* of the first
 * SDK load lands after the window is on screen instead of in front of it.
 *
 * Two facts decide the design:
 * - **No window may ever open.** The packaged app starts its server and keeps it
 *   alive with the window hidden in the tray (SSR-000089 ①), and a headless
 *   server is a normal deployment. Waiting for a request that never comes would
 *   silently turn the dispatcher off, so the wait has a floor: after
 *   `FIRST_SCREEN_FALLBACK_MS` the gate opens by itself and says why in the log.
 * - **Route modules and the instrumentation hook are separate module instances**
 *   in the packaged server, so the flag lives on `globalThis` (a `Symbol.for`
 *   key), exactly like the session registry and the running-session snapshot.
 */

const STATE = Symbol.for("pi-web:first-screen-served");

/** After this long, a first screen that never asks must not keep the pump off. */
export const FIRST_SCREEN_FALLBACK_MS = 15_000;

/**
 * The gap between "the first screen answered" and "background work may start".
 *
 * The marker is set while `/api/sessions` is being answered; the page then asks
 * for the open session, its state, the model list and the font list. Those are
 * the requests a user actually waits for, so the pump gives them a head start
 * rather than competing for the same event loop.
 */
export const FIRST_SCREEN_QUIET_MS = 1_500;

export type FirstScreenWait =
  | { reason: "served"; source: string; waitedMs: number }
  | { reason: "timeout"; source: null; waitedMs: number };

interface GateState {
  servedAt: number | null;
  source: string | null;
  waiters: ((wait: FirstScreenWait) => void)[];
}

function state(): GateState {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[STATE];
  if (existing) return existing as GateState;
  const fresh: GateState = { servedAt: null, source: null, waiters: [] };
  holder[STATE] = fresh;
  return fresh;
}

/**
 * Record that the app's first screen has been answered.
 *
 * Idempotent, and safe to call from any route: only the first call counts, so a
 * session-list poll a minute later cannot re-open a gate that already opened.
 */
export function markFirstScreenServed(source = "sessions"): void {
  const gate = state();
  if (gate.servedAt !== null) return;
  gate.servedAt = Date.now();
  gate.source = source;
  const waiters = gate.waiters.splice(0);
  for (const waiter of waiters) {
    waiter({ reason: "served", source, waitedMs: 0 });
  }
}

/** When the first screen was answered, or null while nobody has asked yet. */
export function firstScreenServedAt(): number | null {
  return state().servedAt;
}

/**
 * Resolve when background work may start: on the marker, or after the fallback.
 *
 * Never rejects and never keeps the process alive — the timer is `unref`'d, like
 * the pumps' own intervals.
 */
export function whenFirstScreenServed(timeoutMs: number = FIRST_SCREEN_FALLBACK_MS): Promise<FirstScreenWait> {
  const gate = state();
  const startedAt = Date.now();
  if (gate.servedAt !== null) {
    return Promise.resolve({ reason: "served", source: gate.source ?? "sessions", waitedMs: 0 });
  }
  return new Promise<FirstScreenWait>((resolve) => {
    const done = (wait: FirstScreenWait) => {
      clearTimeout(timer);
      gate.waiters = gate.waiters.filter((candidate) => candidate !== done);
      resolve({ ...wait, waitedMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => done({ reason: "timeout", source: null, waitedMs: Date.now() - startedAt }), timeoutMs);
    timer.unref?.();
    gate.waiters.push(done);
  });
}

/** Test seam: forget that a first screen was ever served in this process. */
export function resetFirstScreenGate(): void {
  const holder = globalThis as Record<symbol, unknown>;
  holder[STATE] = { servedAt: null, source: null, waiters: [] } satisfies GateState;
}

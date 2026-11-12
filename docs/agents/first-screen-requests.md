# First-screen requests (TASK-000113)

Every request the packaged app answers **before `app_ready`** — i.e. before the
desktop shell shows its window — and what each one may cost. The rule that came
out of TASK-000108 → 000110 → 000113 lives in `lib/first-screen-graph.test.mjs`:
nothing on this path imports `@earendil-works/*` statically, and the request
that needs the SDK pays for it with a deliberate `await import()`.

## Why the rule is "all of them", not "one of them"

The shell keeps its window hidden until the page reports `app_ready`
(`components/desktop/useReportDesktopReady.ts` → `src-tauri`'s `app_ready`), and
`app_ready` is gated on the first screen's data. The pi SDK is
server-external, so **one** static symbol from it loads a 37 MB ESM graph and
blocks the event loop for ~1.4–2.0 s inside the packaged Node.

Three attempts to fix this by moving the import each succeeded locally and each
left `main window revealed` where it was, because the cost simply landed on the
next request the first screen makes:

| Build | The request that paid | Before | After |
| --- | --- | --- | --- |
| `TASK-000108` | `GET /api/desktop/identity` (through the instrumentation graph) | 3080 ms | 1507 ms |
| `TASK-000110` | `GET /api/sessions` | 1624 ms TTFB | 148 ms TTFB, and `GET /api/sessions/[id]` went 41 → 1472 ms |
| `TASK-000113` (this) | `GET /api/custom-css` — a `<link>` in the layout, fired right after the HTML | 2152 ms TTFB, 2113 ms of blocked loop | 32 ms TTFB, no stall |

That fourth row is the point of this document: on the build TASK-000110
produced, the SDK was loaded by a request nobody had looked at — the inline
stylesheet link — several seconds before the session restore that was supposed
to be the culprit.

So the two requests in the old note were *serial* for a structural reason, not
by accident: the browser requests `/` , then everything the page references
(CSS, JS, `/api/custom-css`), then whatever the hydrated app fetches
(`/api/sessions`, then `/api/sessions/[id]`). Each dependency is only started
after the previous response arrives, so the total is `page + css + hydration +
data`. Making one of them fast without the others only relocates the 1.4 s into
the next link of the same chain.

## Result (build `9f9fee7+dirty`, buildId `_zNY5nQhGafMjIGRhOpK4`)

Same protocol, same machine, same WebView profile (both arms restore the same
chat), 10 interleaved cold starts per arm, the first of each discarded
(Defender's first read of a fresh payload):

| arm | build | `main window revealed` (ms) |
| --- | --- | --- |
| A | `9f9fee7+dirty`, buildId `X7P04ElszMyZZVv479XET` (before) | 4706, 4652, 4614, 4614, 4572, 4699, 4952, 4788, 4764, 4763 → median **4699** |
| B | `9f9fee7+dirty`, buildId `_zNY5nQhGafMjIGRhOpK4` (after) | 3525 (discarded), 2687, 2653, 2659, 2614, 2701, 2800, 2686, 2705, 2712 → median **2687** |

**Median reveal −2012 ms**, and the whole reveal now happens **+2464 ms** after
the server process starts instead of +4190 ms.

Before (arm A's last run, `server.log`):

```
[probe] #3 GET /api/custom-css start +1589ms inflight 1
[probe] stall 2113ms ending +3708ms during #3 GET /api/custom-css
[probe] #3 GET /api/custom-css done +3740ms dur 2152ms status 200 inflight 0
```

After (arm B's last run, `server.log`) — no request-attributable gap over 77 ms:

```
[probe] stall 494ms ending +519ms during -      ← Next's own bootstrap, no request yet
[probe] stall 719ms ending +1263ms during -     ← same, before the first connection
[probe] stall 53ms  ending +1341ms during #1 GET /api/desktop/identity
[probe] stall 77ms  ending +1814ms during #6 /api/agent/running/events, #7 /api/sessions, #9 /api/appearance/fonts
[probe] stall 67ms  ending +1906ms during #6, #7, #12 /api/sessions, #13 /api/scheduled-tasks/events
[probe] stall 56ms  ending +2252ms during #6, #13, #22 /api/worktrees, #23 /api/sessions/[id], #26 /api/agent/[id]/events, #27 /api/project-trust
```

Every `GET /api/custom-css` in that run: 32 ms. `GET /api/sessions/[id]`: 187 ms
TTFB, largest stall 56 ms, on the same request that used to be measured at
1472 ms when it happened to load the SDK. One request before the reveal is
still over 200 ms and it is not a stall: `/api/sessions` at 274 ms / 179 ms
TTFB, which is the catalogue scan itself (TASK-000110 territory).

The two gaps that remain over 300 ms are the server process bootstrapping Next
*before* it accepts a connection (`[Entity Assistant] next bootstrap took …`),
which no request can be blamed for and which the shell already waits on before
it asks for `/api/desktop/identity`.

## 之后的那一段：reveal 之后仍会冻结的请求（DEFECT-000101）

上面的清单回答的是「这个请求可以静态加载 SDK 吗」。0.10.0 的六次冷启动暴露了第二种形状：
请求落在**窗口出现之后**，用一次刻意的 `await import()` 付掉 SDK 的 2.6–2.9 s 模块加载，
于是用户正在打字时主线程被按住（`event loop blocked for 2751–2999 ms`，ended +5.6~+6.0 s）。

`GET /api/models` 就是这类：它答的是输入框的模型列表，实测在 reveal 后 +2.5 s 左右到达。
现在它不再等 SDK —— 有缓存（含上一次运行留下的快照 `~/.pi/agent/pi-web-models-cache.json`）
直接返回，没有就回一个占位体并带 `modelsPending: true`，真正的构建在 worker 线程里
（`lib/models-worker.ts` + `lib/models-worker-source.ts`），完成后写缓存，客户端看到
`modelsPending` 会再取一次。

`lib/first-screen-graph.test.mjs` 的 `OFF_THREAD_ROUTES` 为这类「reveal 之后的请求」再压一条断言：
该 route 的静态图里**不得出现任何运行时的 SDK specifier**（静态或 `import()` 都算），
且必须通过 worker 模块取数——否则去掉功能也能"满足"第一条。

## Route files under the rule

`lib/first-screen-graph.test.mjs` walks exactly these, and fails when this
document and that list disagree, so a route added to the inventory cannot skip
the guard and a route removed from the guard cannot stay in the inventory:

- `app/api/desktop/identity/route.ts`
- `app/api/custom-css/route.ts`
- `app/api/scheduled-tasks/route.ts`
- `app/api/scheduled-tasks/events/route.ts`
- `app/api/push/config/route.ts`
- `app/api/sessions/route.ts`
- `app/api/sessions/[id]/route.ts`
- `app/api/sessions/[id]/context/route.ts`
- `app/api/sessions/[id]/state/route.ts`
- `app/api/appearance/fonts/route.ts`
- `app/api/home/route.ts`
- `app/api/chat-workspace/route.ts`
- `app/api/agent/running/events/route.ts`
- `app/api/agent/[id]/events/route.ts`
- `app/api/events/subscriptions/route.ts`
- `app/api/worktrees/route.ts`
- `app/api/cwd/status/route.ts`
- `app/api/views/route.ts`
- `app/api/project-trust/route.ts`
- `app/api/models/route.ts`

## How this list was produced (reproducible)

1. `PI_FIRST_SCREEN_PROBE=1` in the environment of the launched app. The
   launcher (`desktop/server-launcher.cjs`) then logs, into `server.log`:
   - `[probe] #n METHOD /path start +Xms inflight N` and
     `… done +Yms dur Zms status S` for **every** request, and
   - `[probe] stall Nms ending +Xms during #a …, #b …` for every event-loop gap
     of ≥50 ms seen by its 25 ms tick, naming the requests that were in flight
     when the gap started.
   Off unless asked for; `scripts/server-launcher-startup-timing.test.mjs` pins
   both the format and that a normal start stays silent.
2. `desktop.log` (`%LOCALAPPDATA%\com.abcwyc.pi-agent\logs\desktop.log`) for
   `main window revealed by ui ready (chat, page +Nms) (+Mms)`.
3. `node scripts/first-screen-inventory.mjs <server.log> <desktop.log>` prints
   the requests answered before that reveal, each with its TTFB and the largest
   stall it overlapped.
4. Static import graph: `lib/first-screen-graph.test.mjs` walks each route's
   static imports with the same walker as `lib/instrumentation-graph.test.mjs`
   and fails on `@earendil-works/*`.

## The inventory (build `9f9fee7+dirty`, cold start restoring a chat)

31 requests, `main window revealed` at **+4190 ms** after the server process
started (page `+2819 ms` from the WebView's own clock). SDK reachability is the
pre-fix state; the "now" column is what this task changed.

| # | request | static SDK before | now | TTFB before | largest stall |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET /api/desktop/identity` | no | no | 74 ms | – |
| 2 | `GET /` (page) | no | no | 32 ms | – |
| 3 | `GET /api/custom-css` | **yes** (`getAgentDir` from the root) | no (`lib/agent-dir.ts`) | **2012 ms** | **1982 ms** |
| 4 | `GET /api/scheduled-tasks` | no | no | 17 ms | – |
| 5 | `GET /api/push/config` | **yes** (`lib/web-push.ts` → `SessionManager.listAll`) | no (`listAllSessions`) | 47 ms | – |
| 6 | `GET /api/sessions` | no (TASK-000110) | no | 206 ms | 51 ms |
| 7 | `GET /api/appearance/fonts` | **yes** (`lib/artifact-settings.ts`) | no (`lib/agent-dir.ts`) | 9 ms | – |
| 8 | `GET /api/home` | no | no | 7 ms | – |
| 9 | `GET /api/chat-workspace` | no | no | 61 ms | – |
| 10 | `GET /api/scheduled-tasks/events` (SSE) | no | no | – | 70 ms |
| 11 | `GET /api/home` (second) | no | no | 5 ms | – |
| 12 | `GET /api/agent/running/events` (SSE) | **yes** (`lib/rpc-manager`) | no (`lib/session-registry`) | – | 70 ms |
| 13 | `GET /api/scheduled-tasks` | no | no | 6 ms | – |
| 14 | `GET /api/sessions` | no | no | 133 ms | 51 ms |
| 15 | `GET /api/sessions` | no | no | 7 ms | – |
| 16–21 | `GET /api/events/subscriptions` ×6 | no | no | 3–7 ms | – |
| 22 | `GET /` (client-side) | no | no | 8 ms | – |
| 23 | `GET /api/worktrees` | no | no | 85 ms | – |
| 24 | `GET /api/sessions/[id]` (restore the chat) | **yes** (`lib/rpc-manager`, `lib/session-reader`) | no (`lib/session-read.ts`) | 176 ms* | 70 ms |
| 25 | `GET /api/cwd/status` | no | no | 95 ms | 70 ms |
| 26 | `GET /api/views` | **yes** (`getAgentDir` from the root) | no (`lib/agent-dir.ts`) | 16 ms | – |
| 27 | `GET /api/agent/[id]/events` (SSE) | **yes** (`lib/rpc-manager`, and it *started* an agent) | no (`waitForSession`) | – | 70 ms |
| 28–29 | `/icons/icon-192.png` | no | no | 4 ms | – |
| 30 | `GET /api/project-trust` | **yes** (`lib/project-trust` → `ProjectTrustStore`) | no (`lib/pi-trust-store.ts`) | 24 ms | – |
| 31 | `GET /api/sessions/[id]/state` | **yes** (`lib/rpc-manager`) | no (registry; SDK only if live) | 8 ms | – |

\* #24 is cheap here *only because* #3 had already loaded the SDK 2 s earlier.
On the same build without a preceding SDK load the same request measured
**1472 ms** (TASK-000110's note) — the whole point of listing all 31 instead of
the slowest one.

Also fetched, but *after* the reveal in this start: `GET /api/models` (the model
catalogue, which genuinely builds a `ModelRuntime`). It is in
`FIRST_SCREEN_ROUTES` anyway: its static graph is clean now, and a new caller
that fetches it before `app_ready` should have to think about the cost rather
than discover it.

## What each route does now

- **`lib/session-read.ts`** — the JSONL entry reader that replaced
  `SessionManager.open` for the first screen: entries, leaf, tree (labels
  included), session name, header, with the same fingerprint cache budget as the
  manager cache. `lib/session-read.test.mjs` compares every field against
  `SessionManager.open()` on real files (branches, labels, compaction, torn
  lines, legacy versions). `SessionManager` still owns every *mutable* path:
  appending, branching, renaming, deleting (`app/api/sessions/[id]/mutations.ts`),
  and a live wrapper's own manager is read through a structural view.
- **`lib/session-context.ts`** — the entries→UI projection (`buildSessionContext`,
  `sliceActiveBranch`, the compaction/branch dividers), moved out of
  `lib/session-reader.ts` so both first-screen session routes can use it without
  the SDK.
- **`lib/session-registry.ts`** — also owns the running-state broadcast and the
  cwd-scoped helpers (`hasBusyRpcSessionForCwd`, `destroyRpcSessionsForCwd`,
  `waitForSession`); `lib/rpc-manager.ts` re-exports them.
- **`lib/pi-trust-store.ts`** — pi's `dist/core/trust-manager.js` loaded
  synchronously by file URL (`requireSdkModuleSync`, Node's `require(esm)`), so
  the trust read stays the SDK's own code and stays off the 37 MB root.
- **`app/api/agent/[id]/events`** — no longer starts an agent runtime. A
  restored chat is not running; the stream opens, publishes its transport
  `connected` frame, and attaches the moment a wrapper appears (a prompt, a
  scheduled task, a dispatch starts one). `POST /api/agent/[id]` was already the
  thing that creates it.
- **`app/api/models`**, **`app/api/views`**, **`app/api/project-trust`**,
  **`app/api/custom-css`**, **`app/api/appearance/fonts`**, **`app/api/push/config`**
  — SDK imported (if at all) at the call.

## Response shape (unchanged)

`GET /api/sessions/[id]` and `GET /api/sessions/[id]/context` were compared
between the two arms on the same session file, after dropping the volatile
fields (`snapshotRevision`, `modified`, `filePath`, `totalActiveMs`):
`assert.deepStrictEqual` passes, and the set of object key-sets is identical.
`/context` is byte-identical. The detail payload differs only in the *insertion
order* of `toolResult` message keys (`details` before or after
`isError`/`durationMs`/`timestamp`): the old path read through the read-only
manager cache, which deletes and re-adds `details` while slimming, and the new
one keeps the file's order. `JSON.parse` gives the same object either way.

## Trade-offs (deliberate, not accidental)

- **The SDK is now paid on the first *interaction*.** Nothing on the first
  screen loads it, so the first prompt's `POST /api/agent/[id]` (or whatever
  first needs an agent) pays the ~1.4 s. That is a latency change the user can
  see, in exchange for the window appearing ~1.4 s earlier. A post-reveal
  "warm the runtime" step would remove it, and was not added: that is the
  preloading/warming the task boundary excludes.
- **A restored chat no longer has an idle agent runtime.** Extension
  `session_start` handlers, MCP server connections and the live
  `get_state` payload (context usage, extension statuses) now begin at the first
  prompt instead of at launch. `GET /api/sessions/[id]/state` answers
  `{ running: false }` until then — which is what it already answered on a cold
  start, where the runtime was still being built when the request arrived.
- **A session file older than format 3 still goes through `SessionManager`**
  (dynamically), because opening one migrates and rewrites it. The cost returns
  for those files only; the alternative was a read that silently differs from
  what the SDK would write.
- **Memory**: the read cache and the manager cache can hold the same big
  session twice (each bounded by its own byte budget). The alternative was
  sharing one entries array between a cached view and a mutable-unsafe manager.

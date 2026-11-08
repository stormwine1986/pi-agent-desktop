# 视图观察：把视图里的实体派给本地项目自动执行（view-watch）

> **已归档，不再是最新口径。** 现行契约见 `SR-000032` 与 `SSR-000089`（VW-WATCH）/ `SSR-000090`（VW-CLAIM）/
> `SSR-000066`（VW-CFG）。本文保留的是**推理过程**，不是可照着配的说明书。
>
> 一句话：**给一条视图配上 `watch`，视图里还有待处理的实体，就把最老的那条派给指定项目开一个会话去做；同一个项目同时最多一个会话在跑。**

## 与现状的冲突（2026-11-08）

照下文配置会直接报错或行为不同，先看这张表：

| 本文写的 | 现状 |
| --- | --- |
| `claim.back`：失败归还到待处理态，下一轮再试 | **已移除**。失败直接进 `claim.manual`，不重试 |
| `maxFailures`：连续失败上限 | **已移除**。没有重试也就没有上限；写了会报错 |
| 「状态：设计已定，未实现」 | 已实现，并跑过真回合 |
| 泵只写「认领 / 归还」两个迁移 | 泵只写「认领 / 待人工」两个迁移 |

原因见 `SSR-000090` 的【为何不重试】：泵的判据只有“会话结束时它是否还是认领态”，分不出“活没干”与“干了没记账”，重跑只会得到同样的结果。

## 修订（2026-11-08）

五处更正，前三处把「缺陷专用」拉回「任意实体」，后两处纠正泵的生死条件与占用方式：

| 原设计 | 现在 | 原因 |
| --- | --- | --- |
| watch 的是缺陷；配置写 `promoteTo: FIXED`、回写 `solution` 字段 | watch **任意实体**；业务字段**完全归执行项目** | 视图查什么就该观察什么；怎么记账是执行项目自己的事，机制不该认识 `Defect`，也不该认识 `solution` |
| 按缺陷解析 `affects` → 子系统 → `routes` 派到不同仓库 | **一条视图 → 一个本地项目**（`watch.project` 单值） | 要派给 N 个执行项目，就写 N 条视图。路由不再逐条判断 |
| 泵按模板回写 `transition: { to, fields }` | **删掉**。执行项目自己写业务字段（MCP 已预配） | 泵不猜“该写哪个字段”——那是业务，不是调度 |
| 泵挂在待办面板的轮询上：面板收起、切到别的 tab、窗口不可见都会停 | **服务端循环**：应用不退出就派发 | 守护最该工作的时刻，恰好是人不盯着它的时候 |
| 派发前不动实体，靠本地 run 日志去重 | **认领**：派发前把状态推进到配置的认领状态（`claim.to`），失败时归还 | 占用是实体上的**共享事实**，跨机器成立；本地日志只在这台机器上有效 |

连带删除：`affects` 解析、`routes` 映射、路由缓存、`ambiguous` / `no-route` 两个状态、**`transition` 与业务字段回写**、**以及「面板轮询是唯一触发源」这个前提**（`/api/views?watch=1` 不再必需）。

> 泵写实体这件事在 2026-11-08 反复过一次，界线定在这里：**泵只写「认领 / 归还」这一个状态迁移**（外加该状态自身的必填常量字段），**不写任何业务结论**。前一次删掉的是后者。

## 0. 已定的取舍

| 问题 | 决定 |
| --- | --- |
| **watch 什么** | **任意实体**。`watch` 挂在视图上，视图 DQL 查什么就观察什么，配置里不出现实体类型名 |
| **派给谁** | **一条视图 → 一个本地项目**（`watch.project`，单值）。多个模块 = 多条视图 |
| 「新的」怎么判定 | 不判新。视图就是待处理队列，有就处理 |
| 一个任务处理几条 | 一条。会话与日志里带 key |
| 「活动会话」 | 指**正在跑**。结束即释放，允许下一个 |
| **守护什么时候跑** | **应用不退出就派发**。服务端循环，与面板是否打开、切到哪个 tab、窗口是否可见全无关 |
| **标签**存哪 | `处理中` / `需要人工` / `重试 2/3` 这类**执行状态**不写进 entity，只在本地 run 日志，面板渲染时叠加 |
| **占用**存哪 | 认领状态写进 entity。占用必须是共享事实——本地日志别的机器看不见，也防不住别人重复派 |
| 任务边界 | 由 prompt 文件决定（改代码 / 写文档 / 只做分析），机制不预设 |
| **怎么防重复派发** | **认领**：派发前把实体推进到配置的认领状态（`claim.to`）；写成功才算派出，后到者拿 `CONCURRENT_WRITE_CONFLICT` |
| **完成怎么判** | 会话结束时实体**还是不是认领状态**；仍是 → 没做完。在**会话结束那一刻**判，不靠轮询 |
| **谁写实体** | 泵只写**认领 / 归还**；业务字段（结论、方案、说明）一律由执行项目写 |
| 工作区脏了 | 只回滚本次会话碰过的路径；判断不了就停手标「需要人工」 |

## 1. 形态：服务端循环，遍历「可见项目」

泵是**服务端的一个循环**，挂在与 `startScheduler()` 同一个位置（`instrumentation-node.ts`）：

```
server boot → startWatchPump()
  每 60s 一 tick：
    for project of 可见项目                 ← 与侧栏同一个来源：有会话的 cwd
      for view of readViews(project) 里带 watch 的视图
        if 到期 → pump(project, view)       ← 单飞；取最老一条 → 派到 watch.project
```

**为什么不是「面板开着才泵」**（2026-11-08 更正）。实测过三种「开着但没在用」，面板驱动全都会停：

| 情况 | 代码事实 |
| --- | --- |
| 右面板收起 | `AppShell.tsx:3258` `{rightPanelOpen && (` — 整块卸载 |
| 面板开着，切到文件/实体 tab | `AppShell.tsx:3406` 只挂载 active viewer |
| 窗口被遮住或最小化 | `ViewsPanel.tsx:187` 的 `visibilityState === "visible"` 判断 |

而守护最该工作的时刻，恰好是人不盯着它的时候。

「跟项目走」仍然成立，但含义改为：**应用不退出就派发**。打包版的服务器在窗口收进托盘后仍在跑（`instrumentation-node.ts:10` 的既有注释；Tauri 侧 `src-tauri/src/lib.rs` 用 `window.hide()` 隐藏窗口，不退出进程），所以切 tab、切到别的 app、最小化都不影响；只有进程退出才停。

**不需要新清单**：侧栏那个「Workspaces (6)」本身就是项目列表，服务端用同一份数据（`getRecentProjects()`，`lib/project-groups.ts:12`，跳过 `workspaceKind === "chat"`）算即可。

代价（接受）：从未在应用里出现过的项目（一条会话都没有）不会被派发——它本来也看不见。

## 2. 两个项目角色

```
board-ws       看板与调度配置在这（views.yaml，以及它需要的 entity 凭据）
run-ws         会话在这里执行（watch.project 指向它）：读实体、干活、写回都在这里
```

两者可以是同一个项目（`project: .`），也可以不同。**一条视图只指向一个 `run-ws`**，这是本设计的硬边界。`run-ws` 的 MCP / skills / 权限由它自己配好，不归本设计管——泵只需要知道“这个目录能干活”。

## 3. 配置

```yaml
# board-ws/.pi/views.yaml
views:
  - title: 待修缺陷（滤芯模块）
    server: entity-base
    workspace: ws_manhu
    # 模块切分在视图的 DQL 里表达，不在 watch 里（见 §3.1）
    dql: "type = 'Defect' and state = 'CONFIRMED' and affects = 'ssys_…'"
    watch:
      enabled: true
      project: ../module-a-ws        # 单值；相对路径按 views.yaml 所在项目解析
      prompt: .pi/prompts/watch.md   # 任务说明模板，占位符见 §8
      intervalSec: 90
      maxAttempts: 3
      cooldownMin: 30
      claim:
        to: IN_PROGRESS              # 派发前推进到这里（状态名由底座状态机决定）
        back: CONFIRMED              # 失败时退回；不写 = 退回派发前的状态

  - title: 待补规格的 SSR          # 同一条看板，另一条视图，另一个项目
    server: entity-base
    workspace: ws_manhu
    dql: "type = 'SSR' and state = 'DRAFT'"
    watch:
      enabled: true
      project: ../spec-ws
      prompt: .pi/prompts/spec.md
      claim:
        to: IN_PROGRESS
```

**状态名不写死在代码里**：认领状态是底座状态机的一部分，不同实体类型、不同客户模型可以叫不同名字（`IN_PROGRESS` / `ASSIGNED` / `处理中`）。`claim.to` 由配视图的人填，泵只做两件事：往这个状态推一次、失败时退回。

配置里**没有**「成功后写什么字段」。缺陷修完推到 `FIXED` 还是 `INVALID`、`solution` 怎么写，是 `module-a-ws` 自己（它的 prompt、它的 MCP、它的权限）决定的事；SSR 补完要不要进 `DEFINED`，是 `spec-ws` 的事。泵只负责**认领**与**归还**，中间全是执行项目的。

一条视图要想让认领真的生效，它的 DQL 必须**排除认领状态**——否则推进了它还在视图里，认领变成假动作。这一条由 §5 的自检兜住。

### 3.1 模块归属不归 watch 管

「只有滤芯模块的缺陷才派给 module-a」这件事，由**视图的 DQL** 表达：

```
type = 'Defect' and state = 'CONFIRMED' and affects = 'ssys_54e1f9bb…'
```

三个已核实的事实（2026-11-08 实测）：

- DQL 支持关系等值谓词 `<关系> = '<ID>'`，**按实体 id 匹配，不是 key**（`manhu-dql-query/references/dql-syntax.md`；本环境跑过 `type='Defect' and violates='<假 id>'` 不报错、返回 0 条）；
- `Defect.affects → SSYS` 在类型图里**已存在**（`targetEntityTypes: ["SSYS"]`，目标状态限 `DEFINED`）；
- 所以「一个模块一条视图」在今天就能写，不需要新字段。

代价说清楚：**写视图的人要拿到子系统的实体 id**（不是 `SSYS-000003` 这种 key）。这比按 key 难用，但换来的是 watch 里没有任何实体专属逻辑。若客户不接受，正确的解法是让 DQL 支持按 key，或者给 Defect 加字段——**不是**在 watch 里加一套按缺陷的路由。

## 4. 泵与执行项目的分工

| 谁 | 做什么 | 为什么 |
| --- | --- | --- |
| **泵**（board-ws 上下文） | 判定该不该派、**认领**（推到 `claim.to`）、拼 prompt、起会话、**归还**（失败时退回）、记账 | 它只需要知道“队列里有一条、项目空闲、我认得回来”，不需要知道这条实体的业务规则 |
| **执行项目**（run-ws） | 读实体与关联、干活、**写业务结论并把状态推进到完成态** | 它的 MCP 与 skills 已预配；`solution` 怎么写、推到 FIXED 还是 INVALID，是它的事 |

这条分工的意义是**划清责任边界**，不是省事：泵拿到的只有视图行（`key` / `state` / 字段），它无法判断“这个缺陷该推到 FIXED 还是 INVALID”——那要看修没修成、有没有判重。让泵写业务，只能写模板，而模板猜不中业务。

但**占用**不一样：占用不需要判断业务，只需要一句“这条我拿走了”，而且必须写进共享事实里才有意义（本地日志只在你这台机器上）。所以：

- 泵写实体，但只写两件事：派发前 `→ claim.to`，失败时退回 `claim.back`；
- 认领用 `expectedRevision`，撞冲突说明别人抢先 —— 直接放弃，见 §7；
- 执行项目写业务失败怎么办，它自己决定（重试、标注、放弃），泵看不到细节；
- 泵的完成判据是：**会话结束时实体还在不在认领状态**。

## 5. 配置校验（启动即校验，不静默降级）

| 检查 | 不通过时 |
| --- | --- |
| `watch` 挂在有 `server` / `workspace` / `dql` 的完整视图上 | 禁用并说明 |
| `project` 非空、存在、是目录 | 禁用并说明 |
| `prompt` 文件存在且非空 | 禁用并说明 |
| `intervalSec` / `maxAttempts` / `cooldownMin` 是合法正整数 | 禁用并说明 |
| `claim.to` 在该类型的 `lifecycle.validStates` 里 | 禁用并说明可选值 |
| `claim.to` 是当前状态可走的一条路由（`lifecycle.routes`） | 禁用并说明，列出该状态可去的目标 |
| `claim.to` 的必填字段能用 `claim.fields` 补齐，或本来就无必填 | 禁用并说明缺哪个字段 |
| `claim.back`（若写了）是从 `claim.to` 可走的返回路由 | 禁用并说明 |
| **视图的 DQL 排除了 `claim.to`**（派发一次、回读确认它已不在结果里） | 禁用并说明：否则认领是假动作 |

校验只读两样东西：视图配置本身，和该类型的 `get_metadata`。**不读业务字段、不判断该写到哪个状态**——那些是执行项目的。

最后一条是唯一需要真的试探一次的校验：拿一条候选行、推一次认领、再看它是否离开视图；不通过就直接禁掉（而不是等到运行时每条都认领失败）。

## 6. 本地状态：`~/.pi/agent/watch/runs.jsonl`

一行一次尝试，追加写，不覆盖。

```jsonc
{
  "watchId": "entity-base/ws_manhu/待修缺陷（滤芯模块）/DEF-000123",
  "key": "DEF-000123",
  "workspace": "ws_manhu",
  "panelCwd": "D:/projects/board-ws",     // 视图在哪
  "runCwd": "D:/projects/module-a-ws",    // 会话在哪跑
  "sessionId": "…",
  "attempt": 2,
  "stateBefore": "CONFIRMED",          // 认领前的状态：归还时退回这里（claim.back 未配置时）
  "claimedAt": "2026-11-07T01:30:00.000Z",
  "startedAt": "2026-11-07T01:30:02.000Z",
  "endedAt": null,
  "status": "running",
  "entityModifiedAt": "2026-11-07T01:12:03.000Z",  // 派发时实体的最后修改
  "headBefore": "3f2a1c9",        // runCwd 不是 git 仓库时为 null
  "dirtyBefore": [],
  "summary": null,                // 只为展示：回答里 DONE: 之后那句话，泵不据此做任何判断
  "error": null
}
```

`status`：`running` / `done` / `blocked` / `failed` / `timeout` / `conflict` / `claim-failed`。

| 只在认领这一步出现的两个状态 | 含义 |
| --- | --- |
| `conflict` | 认领时撞 `CONCURRENT_WRITE_CONFLICT`：别人（另一台机器 / 另一个人）抢先拿走了。**不计 attempt**、不派会话、下一轮自然不会再命中 |
| `claim-failed` | 认领写失败（无权限、必填没补齐）。**不计 attempt**，面板标「无法认领」并显示服务端原文——这是配置/权限问题，重试没用 |

`claimedAt` 与 `startedAt` 分开：认领成功到会话真的开始之间有几百毫秒，`conflict`/`claim-failed` 只有前者。

派生规则（不额外落盘）：

| 需要知道 | 算法 |
| --- | --- |
| 是否正在跑 | 该 key 最后一条 `running` 且 `sessionId` ∈ `getRunningRpcSessionIds()` |
| 试了几次 | 该 `watchId` 下 `status ∈ {running, done, blocked, failed, timeout}` 的记录数（`attempt` 取最大；`conflict` / `claim-failed` 不算） |
| 需要人工 | `status ∈ {blocked, timeout, claim-failed}`，或记录数 ≥ `maxAttempts` |
| 冷却中 | 最后一条 `endedAt` 距今 < `cooldownMin` |
| 崩溃残留 | `running` 但进程启动晚于 `startedAt` → 归档 `timeout`；同时按 §9.2 决定要不要接管 |

清空方式对使用者自然：删掉对应行 = 重置那条实体的自动化状态。

## 7. 一轮的判定顺序

```
tick():                                   # 服务端定时器，默认每 60s。只派发，不判定
  if 进程租约不是自己                      → return     # dev server 与桌面端各跑一遍
  for project of 可见项目:
    for view of readViews(project) 里 watch.enabled 的视图:
      pump(project, view)

pump(project, view):
  if 该 view 的泵正在跑                   → return     # 单飞（同一 tick 内重复进来）
  if 上一轮距今 < intervalSec             → return
  if 全局 watch 会话数 >= MAX_CONCURRENT_WATCH_RUNS → return
  if view.watch.project 有 running 会话    → return     # 同一个仓库不并发
  rows = runView(project, view)                      # modified_at 升序，最老优先
  for row of rows:
     st = derive(row.key)
     if st.running                                              → skip   # 还在跑：只跳过，不判定（§9）
     if st.blocked / st.cooldown / st.attempts >= max            → skip
     if st 最近一条是 done 且 row.modifiedAt <= 该条的时间戳      → skip   # 见下
     if (server, workspace, key) 已有一条 running（任何视图）     → skip
     # 认领：写成功才算派出，写失败/被抢就换下一条
     claim = promotion(row.key, { to: claim.to, fields: claim.fields, expectedRevision: row.revision })
     if claim 冲突(CONCURRENT_WRITE_CONFLICT) → 记 conflict；continue     # 别人拿走了
     if claim 失败                           → 记 claim-failed；continue # 权限/必填
     写 run 日志 running（stateBefore = row.state, claimedAt = now）
     return dispatch(row, view.watch.project)                           # 判定发生在会话结束时
```

**认领排在最前面**，不是「派完再改状态」：先写成功再起会话，中间没有窗口——否则两台机器会同时起会话、最后只有一个能写。写在前，第二台直接拿冲突退场。

`conflict` 与 `claim-failed` 都不计入 attempt：前者是别人在干（不是失败），后者是配置/权限问题（重试无用，改配置才行）。

多个可见项目之间**互不阻塞**：一个项目在跑，不影响另一个项目派发。全局上限 `MAX_CONCURRENT_WATCH_RUNS` 是个常量（M1 取 2，与计划任务一致），不是配置项——它是防「六七个项目同时开工」的闸，不是给人调的旋钮。

**`done` 不是永久跳过。** 完成之后实体仍可能命中视图（比如推进到 `FIXED` 而视图条件是「未解决」），或者别人又改过它。规则是：**只有实体的 `modifiedAt` 比那次 `done` 更晚，才重新派发**——否则同一份内容会被反复派，白烧 token。

**路由失败这个概念已经没有了**：派发目标在配置里，运行期只有「项目不可用」（校验阶段就拦掉）与「项目正忙」（等下一轮）。

## 8. 会话内的契约

`.pi/prompts/watch.md`，占位符由泵填入（视图行本来就带完整 `fields`，不必让会话再读一次）：

```
你在处理 {{key}}（{{type}}，{{workspace}}），当前状态 {{state}}。

【字段】{{fields}}          ← 该行全部字段，含描述
【关联】{{tracesSummary}}   ← 若取得到，列出上游/下游各一条摘要

执行目录：{{runCwd}}

怎么做、做完要不要改实体，按本项目的约定来（这里只负责把它叫起来）。

回答最后留一行：
   DONE: <一句话说明做了什么>
做不了就只写一行：BLOCKED: <原因>
```

`DONE:` 与 `BLOCKED:` 是**给人和日志用的**，不是状态机：`DONE` 不参与任何判断（完成与否看实体状态，不看它怎么说），`BLOCKED` 是唯一会被泵读取的信号——它把“再试也没用”与“再试可能成功”区分开。

**业务字段归执行项目**（2026-11-08 定）：`solution` 怎么写、推进到 `FIXED` 还是 `INVALID`，都是那个项目的 prompt 与权限范围决定的。泵拿到的只有一个视图行，它没有能力判断“该写什么”。**泵只写认领与归还**——见 §4。

## 9. 判定时机：会话结束那一刻，不是下一次轮询

**问题：下一 tick 时任务还在跑，判失败么？——不判。**

轮询只做一件事：**扫视派发**。判定发生在**会话结束的回调里**，与 tick 无关：

```
dispatch(row, project):                   # 认领已在 §7 完成，此时状态已是 claim.to
  写 run 日志 status=running（stateBefore = 认领前的状态）
  session = startRpcSession(...)          ← 同一进程内：泵与会话都在服务端
  await sendPrompt(session, prompt)
  await session.waitForIdle()             ← 回合真的结束（内部是 agent_end）
  endedAt = now()
  重读该实体：state 还是 claim.to 吗？
      不是 → done      （它去了 FIXED / INVALID / 别的，工作项目已接手）
      是   → failed    （没做完）
```

**判据是「还在不在认领状态」，不是「还在不在视图里」。** 认领那一刻它就已经离开视图了，所以旧判据永远不成立——这是采纳认领方案时必须一起改的地方。新判据还有个好处：不依赖视图的 DQL 是否排除认领状态。

为什么不能挂在 tick 上判：

| 把判定放进去会怎样 | 后果 |
| --- | --- |
| 会话跑 10 分钟，期间 tick 了 6 次 | 每次都要判一次，前 5 次必然误判失败 |
| 判定时点取决于 tick 对齐 | `endedAt` 记的是“下一次 tick 的时间”，不是真的结束时间 |
| 会话在两次 tick 之间起、又落 | 可能漏判，也可能把同一次尝试判两遍 |

`waitForIdle` 是现成的（`rpc-manager.ts:2314`，包的是 `agent.waitForIdle()`）；`agent_end` 也已有既有订阅用法（`lib/mcp-host.ts:564`）。泵与会话在同一个进程里，**不需要靠轮询去猜它跑完没有**。

因此 `running` 这条记录的作用只有两个：占住「这个项目在忙」与「这个 key 正在处理」，**它不参与结果判定**。

### 9.1 结果

| 会话结束时 | 判定 | 处理 |
| --- | --- | --- |
| 实体**已不是 `claim.to`** | `done` | 什么也不做。它去了 `FIXED` / `INVALID` / 别的状态——工作项目已经接手 |
| 回答含 `BLOCKED:` | `blocked` | **停在认领状态**（不归还），标「需要人工」。原因已经由会话说明，再试是浪费 |
| 实体**仍是 `claim.to`** | `failed` | 计一次失败，**归还**（退回 `claim.back` 或 `stateBefore`），冷却后重新入队，直到 `maxAttempts` |
| 已达 `maxAttempts` 的失败 | `failed` | **不归还**，停在认领状态，标「需要人工」。归还就会立刻被重新派发，变成无限循环 |
| 跑了超过 `MAX_RUN_MIN`（常量，M1 取 60 分钟）仍未结束 | `timeout` | 面板标「超时，需人工」；**不杀会话、不释放项目锁**（工作树还被它占着），状态保持认领。它真结束后再判一次，结论覆盖 `timeout` |

`timeout` 不是终局判定，而是**让人能看见**：一个卡住的会话否则会永远显示「处理中」。

### 9.2 归还、接管与卡死

**归还**只做一件事：把状态从 `claim.to` 退回 `claim.back`（未配置则退回 `stateBefore`），带 `expectedRevision`。它**不写任何业务字段**，也不清理别人做的业务改动。

```
归还条件：failed 且 attempt < maxAttempts
归还失败（冲突/无权限）→ 只记日志，不影响后续；实体停在认领状态，面板标「需要人工」
```

**进程崩溃后的接管**：重启时若某条 `running` 记录的实体**仍是 `claim.to`**，且该 key 没有活跃会话：

| 情况 | 处理 |
| --- | --- |
| 本地有这条 key 的记录，且 `attempt < maxAttempts` | 可以接管：归还后重新入队（比什么都不做安全——它确实是泵自己留下的） |
| `attempt >= maxAttempts` | 停在认领状态，标「需要人工」 |
| 本地没有记录，但实体停在 `claim.to` | **不接管**。可能是别的机器派的，动了会打架——留给人工 |

最后一行是这条机制的固有代价：**认领状态卡住是共享可见的，但只有派它的那台机器认得回来**。跨机器卡死只能靠人。这是有意的取舍——自动抢别人的认领，比留一条待人工更危险。

判据仍是：**看实体状态，不看会话怎么说**。会话说“已修复”但状态没动，就是没完成——这比相信自我汇报可靠。

**回滚（只回滚自己碰过的）**：

```
touched = git status --porcelain(失败后) - dirtyBefore(派发前)
对 touched 里每个路径：checkout -- <path>；新增文件 clean -f -- <path>
```

不用 `git reset --hard`：它会连人的未提交改动一起抹掉。判断不了（HEAD 被移动 = 有人在提交）→ 停手标「需要人工」，不动工作区；`runCwd` 不是 git 仓库则整段跳过。

## 10. 并发三层

| 层 | 手段 | 防的是 |
| --- | --- | --- |
| 进程 | `~/.pi/agent/watch/owner.lock`（沿用 `scheduled-tasks/lease.ts` 写法） | 开发服务器与桌面端各跑一遍 |
| **执行项目** | `runningByProject: Map<runCwd, watchId>` + running 判定 | 同一个工作树被两个会话同时改 |
| **实体** | **认领**（`expectedRevision` 抢状态）+ 本地 `running` 记录 | 同一实体被两条视图派一次、被**两台机器**各派一次 |

前两层是本地的，第三层不是：认领借用底座的乐观锁，所以**跨机器也成立**——这是本地日志永远做不到的。两条视图命中同一实体时，第二条会在认领处拿到 `CONFLICT` 而不是拿到同一份工作。

串行键是**执行项目目录**，不再按 entity 工作区——路由下移到视图之后，会被并发破坏的是工作树，而不是实体空间。两条视图指向同一个项目时仍然串行。

## 11. 界面上看得见什么

- **会话**：标题带 key（`DEF-000123`），侧栏标「自动」；
- **待办面板行尾角标**：`处理中` / `需要人工` / `重试 2/3` / `无法认领`；
- **实体状态本身就是最醒目的标记**：被认领的行已经不在待办视图里了，谁打开追溯图都能看到它在 `IN_PROGRESS`——这台机器上的面板只是补充说明，不是唯一线索；
- **暂停**：M1 靠配置里 `enabled: false`（下一 tick 生效，不杀运行中的会话）。面板上的开关放 M2——它的状态要落在服务端读得到的地方，而 `enabled` 已经在文件里了；为此再引入一个本地暂停文件，是重复的一份真相。
- 这些标记只在本地叠加，**不写进 entity**（写进 entity 的只有认领状态本身）。

## 12. 依赖与前置

| 依赖 | 没有它时 |
| --- | --- |
| 视图能跑（`/api/views?apply=1` 已实现） | —— 本设计完全建立在这条之上 |
| **该类型的状态机里有可用的认领状态**（`claim.to`） | 配置校验直接禁用。**这是模型侧的事**：认领状态叫什么、从哪条路由进、能不能退回，全由底座的状态机定义 |
| `watch.project` 指向的项目已配好 MCP / skills | 会话读不到需要的信息、也改不了实体 → 状态停在认领态 → 计失败直到「需要人工」 |
| 执行项目有该实体的写权限 | 同上。**泵不检查权限**——它不知道要写什么，也就无从检查 |
| （仅当客户要按模块切分视图）`affects` 数据真的挂了 | 该视图返回空，泵无事可做；**机制本身不受影响** |

watch 机制**不认识任何实体类型、任何关系、任何业务字段**，但它**认识状态机**——因为认领就是一次状态迁移。这是它唯一需要读懂模型的地方，也是它唯一的模型侧前置。

**这是边界，不是缺陷**（2026-11-08 已确认接受）：**“业务写失败了”在泵看来和“没干活”是同一种情况**——都表现为实体还停在认领状态。因为怎么写、写没写成，本来就是执行项目的事。

推论：

- 诊断看会话，不看泵的状态；泵的「需要人工」只说明“试够了，人来看”。
- 执行项目若想让失败原因在面板上可见，唯一的通道是 `BLOCKED: <原因>`（或自己把原因写进实体）。**泵不会去猜**。

## 13. 明确不做

- 不做按实体的路由解析（已删；要多个执行项目就写多条视图）；
- **不做业务字段回写**（不写 `solution`、不代为推进到完成态）：那是执行项目的事。泵只写认领 / 归还这一个迁移；
- 不做跨机器接管：认领状态卡住时，只有派它的那台机器认得回来，别的机器不抢（见 §9.2）；
- 不做全局「守护项目清单」这个独立配置：项目列表复用侧栏同源的会话项目列表，不另存一份；
- 不做同一项目内的并行（固定一个会话）；
- 不规定提交与推送的行为：提交到哪个分支、要不要 push，由执行项目的 prompt 决定；泵只在失败后清理**它碰出来的**未提交改动；
- 不做自动撤回已提交的 commit（那是人的决定）；
- 不做基于名称/描述等文本的「猜归属」（宁可视图返回空，也不把活派错项目）；
- 不做应用退出后的守护（系统服务 / 开机自启）：进程没了就停，这是设计的边界，不是缺口。

## 14. 测试计划

| 用例 | 断言 |
| --- | --- |
| **右面板收起 / 切到文件 tab / 窗口 `hidden`** | **仍然派发**（泵不依赖任何渲染层状态），且 `document.visibilityState` 为 `hidden` 时也照跑 |
| 应用里可见 3 个项目、其中 2 个配了 watch | 两个都派；第 3 个（没有 watch 配置）不产生任何请求 |
| 一个项目在跑 | 另一个项目照常派（互不阻塞）；总数到 `MAX_CONCURRENT_WATCH_RUNS` 后都等下轮 |
| 该实体有 running 会话 | 不派发，不写日志 |
| **派发前先认领** | 起会话之前状态已经是 `claim.to`；认领失败时**一个会话都没起** |
| **两台机器同时 tick 同一条** | 只有一台认领成功；另一台记 `conflict`、不起会话、不计 attempt |
| 认领撞 `CONCURRENT_WRITE_CONFLICT` | 同上；下一轮该实体已不在视图里，不会再被尝试 |
| 认领写失败（无权限） | 记 `claim-failed`，面板标「无法认领」并显示服务端原文；不计 attempt |
| 视图没排除 `claim.to` | 配置校验阶段禁用并给原因（**不发一次假认领**） |
| 会话结束、状态仍是 `claim.to` | 那一刻记 `failed`，**归还**到 `claim.back`，下一轮重新命中视图 |
| 会话结束、状态已变成别的 | 记 `done`，不再碰状态 |
| 失败到 `maxAttempts` | 记 `failed`，**不归还**（停在认领态），面板标「需要人工」 |
| `BLOCKED` | 记 `blocked`，**不归还**，标「需要人工」 |
| 会话跑 10 分钟、期间 tick 5 次 | 5 次都不判定：不写 `failed`、不重派、`endedAt` 只写一次 |
| 会话跑 90 分钟仍未结束 | 记 `timeout`、面板可见；不杀会话、项目锁不释放、状态保持认领 |
| 进程在会话中途被杀，重启 | 本地有记录且 `attempt < max` → 归还后重新入队；`attempt >= max` → 停手标人工 |
| 重启后看到别人派的认领（本地无记录） | **不接管**，不改状态 |
| 最老优先 | 三条待处理，派 `modified_at` 最早那条 |
| 非 git 项目 | 不写 `headBefore`、不回滚，其余流程正常 |
| 两条视图指向同一项目 | 一条在跑时另一条不派 |
| 会话说 `DONE:` 但状态没动 | 记 `failed`（**看状态，不看自我汇报**） |
| 回滚 | `dirtyBefore` 的文件失败后保持原样；只回滚 `touched` |

（`runView`、`startRpcSession`、`promotion`、`git` 全部依赖注入替身：测试不碰真端点、真仓库。）

## 15. 分期

**M1**：服务端泵循环（`startWatchPump()`，遍历可见项目）+ 视图级 `watch`（`project` / `prompt` / `intervalSec` / `maxAttempts` / `cooldownMin`）+ **认领与归还** + run 日志 + 单飞与项目锁 + 角标。
不做自动回滚（失败就停手标人工）、不做通知、不做暂停开关（用 `enabled: false`）、不做业务字段回写。

**M2**：路径级回滚、失败分类细化、通知、跨轮统计、`watch.order`（默认最老优先）、面板暂停开关。

> 唯一的开工前置在模型侧：**目标类型要有可用的认领状态**（Defect 目前没有，只有 `PROPOSED / CONFIRMED / FIXED / RESOLVED / REGRESSION_FAILED / INVALID`）。这条不解决，`claim` 校验就通不过，功能无法启用——但代码可以先写好，等状态到位即可接。

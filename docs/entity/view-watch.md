# 视图观察：把视图里的实体派给本地项目自动执行（view-watch）

> **分工**：本文讲**机制**——泵每一轮怎么决定、往实体写什么、什么时候判定、失败了往哪去。
> **怎么配**（`views.yaml` 每个键、每条报错文案、交付前自检清单）在
> [工作台视图的配置指南.md](工作台视图的配置指南.md) 第 10 节「派发：`watch`」，两边互相链接，不各写一份。
>
> **契约**：`SR-000032` / `SSR-000089`（VW-WATCH）、`SSR-000090`（VW-CLAIM）、`SSR-000066`（VW-CFG）。
> 本文是实现口径，与代码同步维护：`lib/views/watch/{index,pump,core,runtime,limit}.ts`、`lib/views/fill.ts`、
> `lib/views/order-by.ts`、`lib/views/config.ts`。

**一句话**：给一条视图配上 `watch`，视图里还有待处理的实体，就按**这条视图自己的排序**取第一条认领给
`watch.project` 开一个会话；**一轮最多派一条**，判定发生在**会话结束那一刻**，没做完的直接进「待人工」，不重试。

## 0. 现状口径（2026-11-16）

三个已落地的行为，旧稿里没有或写反了：

| 行为 | 现在的实现 | 落地单 |
| --- | --- | --- |
| **派发顺序** | 待派集合按**视图自己的 `orderBy` / `order`** 向底座取，**第一条**被认领；视图没写 `orderBy` 才回退 `modified_at` 升序 | `TASK-000457`（`a535b47c`）、`SSR-000089` rev33 |
| **只写 `order`** | 配置**报错**「order 需要同时写 orderBy」，不发查询，不再静默忽略 | `TASK-000460`（`e99c41bc`） |
| **转待人工写字段** | 自动进 `claim.manual` 时，按「目标路由 `requiredFields` × `watch.fill` 模板」生成 `fields`；认领本身永远不带 `fields` | `TASK-000461`（`47e85cba`） |

旧稿里**从未实现、已从文档删除**的东西：`claim.back` 归还重试、`maxFailures` 连续失败上限、
`~/.pi/agent/watch/runs.jsonl` 运行记录、失败后自动 `git` 回滚、`watch.order` 配置键。
写 `claim.back` / `maxFailures` 现在会直接报错（不是忽略）；`watch.order` 不在模型里，写了也不生效（派发顺序只看视图级 `orderBy` / `order`）；
泵没有运行记录文件，只有 `[watch]` 日志行（§7）。

## 1. 形态：服务端循环

泵挂在与 `startScheduler()` 同一个位置（`instrumentation-node.ts` 的 `startWatchPump()`）：

```
server boot → startWatchPump()
  每 60s 一 tick：
    if 进程租约不是自己 → return            # 文件租约，见 §9
    for project of 可见项目                   # 与侧栏同源：有会话的 cwd
      for view of readViews(project) 里 watch.enabled 的视图
        if 该视图未在跑 且 距上轮 ≥ intervalSec
          validate（60s 一次）→ pump(project, view)
```

**泵不依赖任何渲染层状态**：右面板收起、切到别的 tab、窗口最小化、窗口收进托盘，都不影响派发
（打包版的服务器在窗口隐藏后仍在跑）。只有进程退出才停——这是设计边界，不是缺口。

`PI_WEB_DISABLE_WATCH=1` 可整块关掉。

**首轮不得和首屏抢**（DEFECT-000100 / TASK-000172 / DEFECT-000104 / TASK-000214）。这一 tick 落在桌面壳
等待的启动窗口里，所以两条规则钉死了它：

1. **第一轮等首屏**：`GET /api/sessions` 答完之后 `markFirstScreenServed()`（`lib/first-screen-gate.ts`），
   再等 1.5 s 静默（`FIRST_SCREEN_QUIET_MS`）才跑第一轮；没人开窗口的部署（托盘启动、headless）由
   15 s 兜底（`FIRST_SCREEN_FALLBACK_MS`）。分钟级 tick 永远排在首轮之后（`firstRound.then(...)`）。
   首轮写一行 `[watch] {"type":"start","after":"first-screen|fallback",…}`，那是「泵为什么晚了」的证据。
2. **首轮与派发门不碰 SDK**：可见项目来自 SDK-free 的 `lib/session-list.ts`，
   「项目忙不忙」来自 `lib/session-registry.ts`。曾经用 `session-reader` / `rpc-manager`：一句 `await import()`
   把 pi SDK 的 ESM 图同步拉进来，隔离打包产物上量到 `event loop blocked for 3415 ms`、首个 204 被推到
   3788 ms；TASK-000172 只换了项目来源之后仍有 2779 ms 的停顿（`deps.projectBusy` 那一句）。
   真派发时付一次 SDK 加载是不可避免的，`startWatchSession()` 外面套了串行队列，那成本只由第一个会话付。

两条规则由 `lib/views/watch/first-screen.test.mjs` 与 `lib/instrumentation-graph.test.mjs` 钉住。

## 2. 两个项目角色

```
board-ws       看板与调度配置在这（views.yaml，以及它需要的 entity 凭据）
run-ws         会话在这里执行（watch.project 指向它）：读实体、干活、写回都在这里
```

两者可以是同一个项目（`project: .`）。**一条视图只指向一个 run-ws**，这是硬边界：要派给 N 个执行项目就写 N 条视图，
机制里没有路由解析，也不认识业务字段。

## 3. 一轮的判定顺序

`lib/views/watch/pump.ts` 的 `pumpView()`，一次调用处理**一条视图**：

```
pumpView(view):
  # ① 先扫过期认领（在闸门之前，闸门关了照样清理）
  claimed = list(slice(from→to), modified_at asc, limit 100)
  for row of claimed: 若 now - row.modifiedAt ≥ timeoutMin → park(manual, reason=timeout)

  # ② 本项目已被泵自己占着？
  if registry[watch.project] → busy(own?)          # 本视图自己的，不是「被挡住」

  # ③ 两道闸门（关了就整条视图本轮不派，一条也不认领）
  if 应用侧该项目有运行中会话        → skipped(session)
  if count(slice(from→manual)) > 0  → skipped(manual, N)

  # ④ 全局上限
  if registry.size >= 生效上限        → skipped(queue, N)

  # ⑤ 取待派集合：视图自己的排序，取第一条
  pending = list(view.dql, view.orderBy ?? modified_at, view.orderBy ? view.order : asc,
                 limit = min(view.pageSize, 100))

  # ⑥ 逐条试认领，成功一条就派出、结束本轮
  for row of pending:
     claim = promotion(key, to: claim.to, expectedRevision: row.revision)   # ← 不带 fields
     冲突(CONCURRENT_WRITE_CONFLICT)   → 记 conflict，试下一条
     业务拒绝(STATE_GUARD_*)           → 记 skipped(policy)，试下一条
     其它失败                          → 本轮记 error，不起会话
     成功 → dispatch(row)：起会话、占项目、写日志 claimed、后台 judge()
```

细节值得单独说清：

- **过期清扫在最前面**是刻意的：一条停太久的认领不是「等待」，是卡住，下一轮派发不能跟这个判断抢。
  这次查询固定用 `modified_at asc`（不跟视图排序），因为它是一个超时扫视、不是队列；逐行按 `modifiedAt` 自己判。
- **判定不在 tick 里**：tick 只派发。会话跑十分钟、期间 tick 六次，不会写六次 `failed`（§4.2）。
- **单飞 + 间隔**：同一视图 `inFlight` 时不重入；`intervalSec` 的判定带 1 s 容差
  （`intervalSec * 1000 - 1000`），否则与 60 s tick 同周期的视图会被隔轮跳过。
- **校验缓存 60 s**：`validate()` 每分钟重跑一次，改完 `views.yaml` 最多等一个周期就生效。

### 3.1 派发顺序 = 视图自己的排序

**视图怎么排，就怎么派**（`SSR-000089` rev33，`TASK-000457`）。泵把 `orderBy` / `order` **原样**交给 `list`，
不本地排序，底座返回的第一行就是它要认领的那一行：

| 视图配置 | 泵实际发的排序 |
| --- | --- |
| `orderBy: modified_at` + `order: asc` | `modified_at asc`（最老先做） |
| `orderBy: modified_at` + `order: desc` | `modified_at desc`（**最新先做**） |
| `orderBy: [priority, modified_at]` + `order: [desc, asc]` | 多键原样下发，按顺序生效 |
| 没写 `orderBy` | `modified_at asc`（历史行为，逐字节保持） |

最后一行是唯一保留的默认：视图的 `order` 默认值是 `desc`，那是**表格的默认**，不是派发的回退值；
没写 `orderBy` 时泵用自己的 `asc`。

被并发认领或被状态机守卫拒绝时**顺延到下一条候选**，顺序不变（`pump.test.mjs` 的 AC-2 / AC-3 三例）。
扫描上限 `min(pageSize, 100)`：一轮只看第一页，够用且不会因为一条视图把整库拉下来。

### 3.2 闸门与上限

三道闸，**全部关整条视图，不是关某一行**（andon 语义，`SSR-000089` ④⑦）：

| 闸门 | 判定源 | 面板文案 |
| --- | --- | --- |
| 执行项目有运行中会话 | 应用侧会话运行态（运行列表 + 每个会话的 `cwd`），**不是**泵的私有索引 | 「项目有运行中会话」 |
| 有 N 条停在 `claim.manual` | 把 DQL 里那句 `state = '<from>'` 换成 `'<manual>'` 再查一次总数 | 「有 N 条待人工」 |
| 全局并发上限 | 泵自己起的、当前在跑的会话数（`registry.size`） | 「排队中：正在执行的任务已达上限（N 个）」 |

- 第二道闸是**按视图**的：一条卡住挡全部。这是有意的——一条走不下去了，人应该先看它，而不是往上堆新活。
- 第三道闸是**进程级**的：`PI_WEB_MAX_WATCH_RUNS`（缺省 2，取值 1~8 夹取，越界/非法在启动日志里写明），
  它防的是「六七个项目同时开工」把机器压满，**不承诺吞吐，也不承诺排队时长**。不写进 `views.yaml`：
  那是按项目的文件，写进去会被复制到每个项目、漂成第二份真相。
- 闸门只影响**派发时机**：关闭期间不认领、不丢条目，打开后下一轮从同一位置继续。
- **「被挡住」不会被「没活干」冲掉**：`skipped` 记的是最近一次有活却没派出去的原因，只有成功派发一次
  或被新原因替换才清；`idle` 是另一个字段（`lib/views/watch/index.ts` 的 `applyOutcome`）。
  所以「被挡住过」和「本来就没活」在面板上不是同一张脸。

## 4. 认领、判定与转待人工

### 4.1 认领是唯一一次「先写成功再起会话」

```
promotion(key, { to: claim.to, expectedRevision: row.revision })    # 注意：没有 fields
```

**认领永远不带 `fields`**：那一刻还没有执行会话，泵没有任何内容可填（`TASK-000461` 的边界）。
认领写成功才算派出——先把状态推进到 `claim.to`，再起会话，中间没有窗口；第二台机器（或第二条视图）
在同一个实体上只会拿到 `CONCURRENT_WRITE_CONFLICT`。占用必须是**实体上的共享事实**，
本地日志别的机器看不见，也防不住别人重复派。

所以「认领路由本身要求必填字段」对泵来说是**配置/模型错配**，在校验阶段就被拒（§5 第 7 关），
而不是到运行期把条目卡在认领态里。

### 4.2 判定：会话结束那一刻

```
dispatch(row):
  session = startSession(runCwd, prompt, title)
  registry[runCwd] = { key, view }            # 占住项目
  log {type: "claimed", …}
  judge()                                      # 后台，不等

judge():
  timer = timeoutMin 到点 → park(manual, reason=timeout)   # 不杀会话、不释放项目锁
  await session.done                            # 回合真的结束
  clearTimeout(timer); registry.clear(runCwd)
  if 已经记过 timeout: return                    # 不覆盖，不重复判
  重读实体：state 还是 claim.to 吗？
      不是 → log done，什么也不写              # 执行项目已经接手
      是   → park(manual, reason=failed)        # 没做完，直接待人工
```

判据是**「还在不在认领态」**，不是「还在不在视图里」：认领那一刻它就已经离开视图了。
完成与否看实体状态，**不看会话的自我汇报**——会话说 `DONE:` 但状态没动，就是没做完。

**没有第二次尝试**（`SSR-000090`【为何不重试】）。泵的判据分不出「活没干」与「干了没记账」，
重跑只会得到同样的结果，而决定下一步是人的事。于是 `claim.back`、`maxFailures`、冷却时间这套全都不存在了：
失败第一次就进 `claim.manual`，从那里要回队列只能由人推回 `claim.from`。

会话标题带序号：`视图名 · KEY`，同一实体再次被派发（只可能是人把它推回了队列）显示 `（第 N 次）`，
N 从 `list_revisions` 的历次状态里数 `countClaims(history, claim.to)`——没有自己的计数器可以漂。

### 4.3 自动转待人工时写哪些字段（`requiredFields` × `watch.fill`）

泵替执行方做的那一次推进（`claim.to → claim.manual`）如果被模型要求必填字段
（例如 `TASK` 的 `IN_PROGRESS → BLOCKED` 要求 `remarks`），内容只能来自配视图的人：

```
get_metadata(type).lifecycle.routes[] 里 from = claim.to, to = claim.manual
  → requiredFields                        # 要写哪些字段，泵不认识这些名字
watch.fill                                # 字段名 → 模板，供上一步的字段名取值
fields = { 每个 requiredField: render(fill[该字段], {key,type,view,reason,from,to}) }
```

三条规则，全在 `lib/views/fill.ts`：

1. **只走交集**。`requiredFields` 没要求的字段，`fill` 配了也不发（配置删掉一个要求，模板自然停止生效，
   而不是变成一次意外写入）；`requiredFields` 要求的字段 `fill` 没配 → 拒绝推这次（`parkFields` 返回错误），
   条目**停在认领态**并记一条 `error`，不会发一次半填的写。
2. **路由不要必填就不带 `fields`**，`promote()` 的第四个参数直接不传——与引入 `fill` 之前逐字节一致。
3. **元数据读不到时按「没有必填」处理**（fail open）。真的要求字段时底座会拒绝这次写，面板上是错误带服务端原文，
   不会静默成功。

`reason` 只有两个值：`timeout`（超过 `timeoutMin`）和 `failed`（会话结束仍停在认领态）。
`from` / `to` 就是 `claim.to` / `claim.manual`。占位符全表与错误文案看
[配置指南的 `watch.fill` 一节](工作台视图的配置指南.md#自动转待人工时写哪些字段watchfill)。

**为什么泵可以写这几个字段，而不算「写业务」**：字段名和是否必填都来自元数据，内容来自配置模板；
泵不知道「这次为什么失败」以外的任何业务事实。业务结论（结论、方案、完成态）仍然只由执行项目写。

**同一个类型在不同部署上可以不一样，别照抄例子。** 2026-11-16 实测：`ws_entity_base` 的 `TASK` 在
`IN_PROGRESS → BLOCKED` 与 `IN_PROGRESS → FINISHED` 上 `requiredFields` 都是**空**（只有 `BLOCKED → FINISHED`
要 `remarks`），而 `manhu` 系列的 `TASK` 这三条路由都要求 `remarks`。所以“要不要填、填哪个字段”只能现场查
`get_metadata`：拿一个部署的模型去配另一个部署的视图，要么 7a 关拦下（要填的没配模板），要么配了却永远不发（路由本来不要）。

### 4.4 两个超时

| 超时 | 起算点 | 用途 |
| --- | --- | --- |
| `expireClaimed`（每轮开头） | 实体的 `modifiedAt` | 上次进程留下的、或别处留下的认领，超过 `timeoutMin` 就转待人工 |
| `judge` 的定时器 | 本次派发的时刻 | 会话超过 `timeoutMin` 还没结束 → 转待人工（先 `get`，仍是认领态才写） |

两者都**不杀会话、不释放项目锁**（工作树还被它占着）。会话后来真的结束了，`timedOut` 短路让结论不被覆盖。

## 5. 校验：启动即校验，不静默降级

`validate()`（`lib/views/watch/index.ts`）只看两样东西：视图配置本身，和该类型的 `get_metadata`。
**不读业务字段、不判断该写到哪个状态**。一条视图过不了下面七关就**完全不派发**：
面板在该视图行标红点，正文写「派发未生效：<缺什么>」，每条拒绝都带视图名。

| # | 检查 | 不通过时点名 |
| --- | --- | --- |
| 1 | `watch.project` 是目录 | 执行项目路径 |
| 2 | `watch.prompt` 存在、可读 | 模板文件路径 |
| 3 | 模板**非空**且正文含 `{{key}}` | 文件路径 + 缺的是 `{{key}}` |
| 4 | DQL 能被切出认领态：**恰好一个** `state = '<值>'` 且等于 `claim.from` | 0 个 / 多个 / 值不一致 |
| 5 | `claim.from` / `to` / `manual` 都在 `lifecycle.validStates` 里 | 哪个字段、可用值 |
| 6 | 状态机里有 `from → to` 和 `to → manual` 两条路由 | 缺哪条路由 |
| 7a | `to → manual` 路由的**必填字段都有 `watch.fill` 模板** | 缺哪几个字段 |
| 7b | 认领路由 `from → to` **不声明必填字段**（`fill` 不作用于认领） | 该路由要求的字段 |

几处容易踩空的地方：

- **第 4 关的错误是兜底不是提示**：`state in (...)`、`state != ...`、两个 `state =` 都切不出认领态，
  一律拒绝，泵不猜。这条也挡住了「认领是假动作」——DQL 里的 `state` 值必须与 `claim.from` 一致。
- **`claim.manual` 不能等于 `from`**，否则转过去的条目立刻被重新派发；这是单独的拒绝（在第 5 关之前）。
- **第 5～7 关需要 `get_metadata`**：DQL 里没写 `type = '...'` 时这三关跳过（其余照查）；
  元数据读不到时视图**禁用**并显示服务端原文，而不是当它通过（`readStates`）。
- **7a 的失败不可能靠重试救**：条目一旦被认领却推不进 `manual`，就永远停在认领态、不在视图里、
  没有任何痕迹。所以校验期就拦下，运行期 `parkFields` 还有第二道（防有人在泵运行时改文件）。
- **7b 为什么是错**：认领那一刻没有执行会话，`fill` 不覆盖认领，泵无从填值——这是模型/配置错配，
  得人去改路由或换一条认领路由。

### 5.1 视图级的两道检查（与派发无关，但决定派发发什么）

这两条是**所有视图**的规则，不是 watch 专属；它们决定泵能不能拿到一个可用的排序：

| 检查 | 在哪 | 不通过时 |
| --- | --- | --- |
| `order` 必须与 `orderBy` 成对 | 解析 `views.yaml`（`lib/views/config.ts`，`ORDER_NEEDS_ORDER_BY`） | 该视图报错「order 需要同时写 orderBy（只写 order 会被忽略，等于没排序）」，**不发查询**。单值与数组同一句 |
| `orderBy` 的键在该类型上存在 | 求值时（`app/api/views/route.ts` → `lib/views/order-by.ts` 的 `checkOrderBy`） | 视图正文报错并**点名是第几个键**（多键时不能只说「有一个键错了」），`list` 不发；元数据读不到时**弃权**，交给 `list` 判 |

`order` 数组的长度必须等于 `orderBy` 的键数；单值作用于全部键；空数组、非字符串键在解析期就拒。
键名比较忽略 `_` / `-` 与大小写（`modified_at` / `modifiedAt` / `modified-at` 同一个字段）。

## 6. 与执行项目的分工

| 谁 | 写什么 | 为什么 |
| --- | --- | --- |
| **泵** | 只写两个状态迁移：认领（`from → to`，不带字段）、转待人工（`to → manual`，带 §4.3 算出的字段） | 它只需要知道「这条我拿走了」「这条我推不动了」，不需要知道这条实体的业务规则 |
| **执行项目** | 读实体与关联、干活、写业务结论、推进到完成态 | 它的 prompt / MCP / 权限自己配好；泵不认识 `solution`、也不认识「该推 FINISHED 还是 INVALID」 |

这条边界不是省事，是**划清责任**：泵拿到的只有视图行，它没有能力判断「这个缺陷该推到 FIXED 还是 INVALID」。
让它写业务只能写模板，而模板猜不中业务。

代价说清楚：**「业务写失败了」在泵看来和「没干活」是同一种情况**——都表现为实体还停在认领态。
诊断看会话，不看泵；执行项目若想让原因在面板上可见，唯一通道是 `BLOCKED: <原因>` 或自己写进实体。

## 7. 日志与可观察

**没有运行记录文件。** 泵每次动作打一行 `console.log("[watch]", …)`（`runtime.ts` 的 `log`），
`dev` 的终端 / `journalctl` / `server.log` 可以直接读：

| `type` | 何时 | 关键字段 |
| --- | --- | --- |
| `limit` | 启动时立刻 | 生效的全局上限、来源（默认 / 环境变量）、是否被夹取 |
| `start` | 首轮真正开跑 | `after: first-screen \| fallback`、`waitedMs` |
| `claimed` | 认领成功、会话已起 | `view` / `key` / `runCwd` / `sessionId` |
| `done` | 会话结束且实体已离开认领态 | `state` |
| `manual` | 转待人工成功 | `reason: timeout \| failed` |
| `conflict` | 认领撞并发写 | `key` |
| `skipped` | 被闸门 / 上限挡住，或被状态机守卫拒绝 | `reason: session \| manual \| queue \| policy`、`count` / `limit` / `message` |
| `error` | 真失败（网络 / 鉴权 / 非策略 4xx / 写不进 manual） | `message` 原文 |

状态机的业务拒绝（`STATE_GUARD_UNSATISFIED` / `STATE_GUARD_BUDGET_EXCEEDED` / `STATE_GUARD_CYCLE`）
是 `skipped(policy)`，**不是 error**：那是「这条还没轮到」，不是「工具坏了」。白名单在
`SKIPPABLE_PROMOTION_CODES`，别的 4xx（如 `ENTITY_VALIDATION_FAILED`）仍然是 error。

## 8. 会话内的契约

`.pi/prompts/watch.md` 由泵渲染后作为派发正文（`renderPrompt`），占位符与「模板要什么才给什么」的规则
见[配置指南的「prompt 占位符」一节](工作台视图的配置指南.md#prompt-占位符)。机制这一侧只有三条：

- 模板是**用户文本**：只替换模板里出现的占位符，没写的既不补空行也不加标题；未知占位符原样保留（拼错能看见）。
- **缺 `{{key}}` 即配置非法**（第 3 关）：会话标题里有 key，但模型看不到自己的标题。
- `DONE:` / `BLOCKED:` 是**给人看的**，泵不读它们；完成与否只看实体状态。

## 9. 并发三层

| 层 | 手段 | 防的是 |
| --- | --- | --- |
| 进程 | `~/.pi/agent/watch/` 下的文件租约（沿用 `scheduled-tasks/lease.ts`） | dev server 与桌面端各派一遍 |
| 执行项目 | `WatchRegistry`（进程内 `Map<runCwd, {key, view}>`，不落盘）+ 应用侧会话运行态 | 同一个工作树被两个会话同时改 |
| 实体 | **认领**（`expectedRevision` 抢状态） | 同一实体被两条视图派一次、被**两台机器**各派一次 |

前两层是本地的，第三层不是：认领借底座的乐观锁，跨机器也成立。串行键是**执行项目目录**——会被并发破坏的是
工作树，不是实体空间。`WatchRegistry` 只记得泵自己起的会话，重启就忘（会话也随进程死了，这是正确的）。

## 10. 界面上看得见什么

判据只有一份：`/api/views` 返回的 `watch` 对象（`null` / `disabled` / `skipped` / `error` / `inFlight`），
面板不另存「是否配了派发」。四种点（`lib/views/watch-indicator.ts`，`SSR-000089` AC-11）：

| 点 | 含义 |
| --- | --- |
| 绿 | 配好了、本轮没有待派（到达间隔就接手） |
| 黄 | 有活却没派出去：被闸门 / 全局上限挡住，或条目被状态机守卫拒绝，悬浮说明给原因 |
| 没有 | 这条视图不派发：没配 `watch`（只读视图）。这是「不派发」的唯一含义 |
| 红 | `enabled: false`（配置里关闭了派发）、七关没过、或上一轮真出错；悬浮说明指出缺什么 |

文案里不出现 `watch` / `claim` / `intervalSec` 这类配置字段名（`plainReason` 会翻译成「待人工状态」「执行项目」
这类人话）；那是给写配置的人看的。泵自己的标记（`处理中` / `需要人工`）只在本地叠加，**不写进实体**——
写进实体的只有状态迁移本身，与它带来的那几个必填字段。

## 11. 依赖与前置

| 依赖 | 没有它时 |
| --- | --- |
| 视图能跑（`/api/views?apply=1`） | 本设计完全建立在这条之上 |
| 该类型有可用的认领状态与 `from → to` 路由 | 校验第 5～6 关禁用 |
| 该类型有 `to → manual` 路由 | 同上；没有「推不动」的落点，机制不成立 |
| `claim.to → claim.manual` 的必填字段都在 `watch.fill` 里 | 第 7a 关禁用 |
| `run-ws` 已配好 MCP / skills / 写权限 | 会话读不到信息或写不进实体 → 停在认领态 → 转待人工 |

watch **不认识任何实体类型、关系或业务字段**，但它**认识状态机**——因为认领就是一次状态迁移，
转待人工还要按目标路由的必填字段写值。这是它唯一需要读懂模型的地方。

## 12. 明确不做

- **不做重试**：失败第一次就进 `claim.manual`（`claim.back`、`maxFailures`、冷却期都已移除，写了会报错）。
- **不做业务字段回写**：不写 `solution`、不代为推进完成态；唯一例外是 §4.3 那次「转待人工」的必填字段。
- **不做自动回滚**：失败不碰工作区、不撤销执行项目的未提交改动（`git` 相关的一整套在实现里不存在）。
- **不做跨机器接管**：认领卡住时只有派它的那台机器认得回来；本地没有记录就**不接管**，留给人工。
- **不做全局「守护项目清单」**：项目列表复用侧栏同源的会话项目列表。
- **不做同一项目内并行**（固定一个会话）。
- **不做按实体的路由解析**：一条视图 → 一个执行项目，多模块 = 多条视图。
- **不做基于文本的「猜归属」**：宁可视图返回空，也不把活派错项目。
- **不做应用退出后的守护**（系统服务 / 开机自启）。
- **不做面板上的暂停开关**：`watch.enabled: false` 是唯一开关（下一轮生效，不杀运行中的会话）。

## 13. 测试钉住的行为

| 用例 | 断言 | 文件 |
| --- | --- | --- |
| 没写 `orderBy` | 发出去的就是 `modified_at asc`，逐字节等于引入派发顺序之前 | `pump.test.mjs` AC-2 |
| 多键视图 | `orderBy` / `order` 数组原样下发，认领的是第 0 行；第 0 行冲突则顺延到第 1 行、顺序不变 | `pump.test.mjs` AC-3 |
| 认领 | 起会话之前状态已是 `claim.to`；**认领不带 `fields`**，即使配了 `fill` | `pump.test.mjs` |
| 转待人工 | `fill` 在 expire / judge failed / judge timeout 三个入口都能到达，`reason` 分别为 `timeout` / `failed` / `timeout` | `pump.test.mjs` |
| 交集 | 路由不要必填 → 一个字段都不发；必填没被 `fill` 覆盖 → 拒绝推、不发半填的写 | `pump.test.mjs`、`fill.test.mjs` |
| 校验第 7 关 | 7a 缺模板点名字段与视图；7b 认领路由声明必填被拒 | `validate.test.mjs` |
| `order` / `orderBy` | 只写 `order` 报「order 需要同时写 orderBy」；数组长度不符、空数组、非字符串都被拒 | `config.test.mjs` |
| 第二键非法 | 多键时错误点名「orderBy 第 N 个键」；元数据读不到则弃权 | `order-by.test.mjs` |
| 闸门 | 项目有会话 / 有 N 条待人工 / 全局上限，各自一句文案，且都不认领 | `pump.test.mjs` |
| 不重试 | 会话结束仍是认领态 → 直接 `manual`，没有第二次尝试 | `pump.test.mjs` |
| 首轮 | 等首屏后开闸、兜底 15 s、分钟级 tick 不超车 | `first-screen.test.mjs` |

（`list` / `promotion` / `get_metadata` / `startSession` 全是依赖注入替身：测试不碰真端点、真仓库。）

## 14. 变更史（为什么是现在这样）

| 变化 | 原因 |
| --- | --- |
| 从「缺陷专用」拉回「任意实体」 | 视图查什么就观察什么；机制不该认识 `Defect` 或 `solution` |
| 删掉 `transition: { to, fields }` 业务回写 | 泵不猜「该写哪个字段」，那是业务 |
| 删掉 `claim.back` / `maxFailures` | 判据分不出「没干」与「干了没记账」，重试学不到新东西（`SSR-000090`） |
| 派发改为按视图排序 | 客户端固定 `modified_at asc` 时，`orderBy: [priority, modified_at]` 这类意图无法表达——视图能排序就该按它派（`TASK-000457`） |
| `order` 单独出现改为报错 | 静默忽略让「没有 orderBy 的 order」看起来生效了，其实没排序（`TASK-000460`） |
| 转待人工带 `watch.fill` | 当时 `TASK` 的 `IN_PROGRESS → BLOCKED` 要求 `remarks`（`manhu` 系列现在仍然如此），不填就推不进去，条目卡在认领态且无声（`TASK-000461`） |

需要设计推演原文时看需求条目（`SSR-000089` / `SSR-000090` / `SSR-000066`），本文只保留能照着实现的结论。

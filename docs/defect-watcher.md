# 缺陷自动处理（watcher / 队列泵）

> 状态：设计已定，未实现。等待 Defect 的 `affects` 关联在目标空间可读后可直接接。
> 一句话：**待办里还有 CONFIRMED 缺陷，就按它所属的子系统找到仓库，开一个会话去修；同一工作区同时最多一个会话在跑。**

## 0. 已定的取舍

| 问题 | 决定 |
| --- | --- |
| “新的”怎么判定 | 不判新。视图就是 `state = 'CONFIRMED'` 的队列，有就处理 |
| “活动会话” | 指**正在跑**。会话结束即释放，允许下一个 |
| 一个会话处理几条 | 一条。会话与标记里带 key |
| 守护什么时候跑 | 跟项目走。项目打开（含恢复）时运行；关掉即停派发 |
| 标签 / 状态存哪 | **不写进 entity**。只在本地 run 日志里，面板渲染时叠加 |
| 处理边界 | 修仓库代码，提交到**主干** |
| `solution` 内容 | 改动摘要 + commit hash |
| 工作区脏了 | 只回滚本次会话碰过的路径；判断不了就停手标“需要人工” |
| **在哪修（路由）** | 按缺陷 `affects` 到的**子系统**映射到本地项目目录，映射写在看板项目里 |
| **模块 ↔ 工作区** | 不预设。一工作区可含多子系统，一子系统也可跨工作区；路由按缺陷逐条解析 |
| **一条缺陷连了多个子系统** | 不猜。各子系统路由一致才派；映射到不同仓库则判 `ambiguous`，标「多子系统」 |
| **会话与实体的分工** | 会话**读**（模块项目 MCP 已预配）、只改代码；**写**（solution + 推进）由泵做 |

## 1. 形态：请求驱动的队列泵

不新增全局定时器。**泵挂在待办面板已有的轮询上**：

```
ViewsPanel 轮询 /api/views?apply=1&watch=1
        ↓
服务端 pump(viewTarget)             ← 单飞，同 target 并发请求直接返回
        ↓
取候选行 → 解析每行的子系统 → 映射到仓库目录 → 派发一个会话 → 追加 run 日志
```

“跟项目走”因此是免费的：面板开着就泵，关掉就停派发。不需要持久化“守护哪些项目”的清单。

代价（接受）：面板关着时不派发；已经跑起来的会话不受影响。

## 2. 三个项目角色

```
manager-ws     看板与路由配置（views.yaml + watch.routes），entity 凭据在这
module-a-ws    仓库 A：会话在这里改代码、提交（MCP/skills 已预配，不归本设计管）
module-b-ws    仓库 B：同上
```

看板所在项目与执行项目**不是同一个**，这是本设计的前提，不是特例。

## 3. 路由：缺陷 → 仓库

缺陷本身没有模块字段（`name / description / priority / solution / regression_notes / state`），
子系统只能从**关联**读：Defect `affects` 子系统。

```yaml
# manager-ws/.pi/views.yaml
views:
  - title: 待修缺陷
    server: entity-base
    workspace: ws_manhu
    dql: "type = 'Defect' and state = 'CONFIRMED'"
    watch:
      enabled: true
      promoteTo: FIXED
      promptFile: .pi/prompts/defect.md
      intervalSec: 90
      maxAttempts: 3
      cooldownMin: 30
      branch: main

      # 子系统从哪条关联读（默认 affects）
      subsystem:
        relation: affects

      # 子系统 → 本地目录。键是子系统实体的 key；name 可作别名
      routes:
        SSYS-000003: ../module-a-ws        # 滤芯模块
        SSYS-000007: ../module-b-ws        # 电控模块
```

规则：

- **解析**：`list_traces(key)` 里取 `linkType`（或其 `inverseLinkType`）为 `affects` 的边，
  对端实体即子系统；用对端的 `key` 查 `routes`（未命中再看 `name`）。
- **一条缺陷连了多个子系统**：逐个查路由，**全部映射到同一目录才派发**；
  映射到不同目录 → 判 `ambiguous`，标「多子系统」，不派发。挑一个去改等于赌博。
- **没有 `defaultCwd`，也没有模糊匹配**。解析不出子系统、或子系统没有对应路由 → **不派发**，
  行尾标「缺子系统 / 缺路由」，并说明卡在哪一步。
- 路由表只存在于本地。实体里不存路径——路径是这台机器的事实，不是缺陷的属性。
- 路由解析带**本地缓存**（按 key，TTL 10 分钟，随 run 日志一起失效）：它是每轮对每行的
  一次 `list_traces`，而 `affects` 极少变。命中即停的循环本来只需解析一条，缓存是给
  「候选很多但都不可派」的情况兜底。

## 4. 会话与实体的分工

| 谁 | 做什么 | 为什么 |
| --- | --- | --- |
| **会话**（module 项目） | 读缺陷与关联、定位代码、改、提交、返回摘要 | 模块项目 MCP 已预配，读所需的一切都在；写代码需要仓库 |
| **泵**（manager 上下文） | 解析路由、拼 prompt、写 `solution`、推进状态、记账 | 写入必须带 `expectedRevision`、必须固定 solution 格式、必须在可控时序里完成 |

这样分工后：

- `solution` 的格式由泵拼装，**不依赖模型自觉**：

  ```
  solution = "{SUMMARY}\n（commit {COMMIT}）"
  ```

- “提交了代码但 solution 没写”这类半成品无法发生——记账在提交之后，且由泵一次完成；
- 会话的工具面更小：它不需要掌握状态机与必填规则，只需要改代码、说清改了什么。

## 5. 配置校验（启动即校验，不静默降级）

| 检查 | 不通过时 |
| --- | --- |
| `watch` 挂在有 `server`/`workspace`/`dql` 的完整视图上 | 禁用并说明 |
| `promoteTo` 是 `lifecycle.routes` 里从当前 state 出发的目标 | 禁用并说明 |
| `promoteTo` 的必填字段能从 `validityRules.stateRequiredFields` 读到 | 禁用并说明（否则派出去必然被底座拒） |
| `routes` 非空，每个 `cwd` 存在且是目录 | 禁用并说明缺哪个 |
| `subsystem.relation` 指定的关联在类型图里存在（Defect → 某类型，`affects`） | 禁用并说明 |

## 6. 本地状态：`~/.pi/agent/watch/runs.jsonl`

一行一次尝试，追加写，不覆盖。

```jsonc
{
  "watchId": "entity-base/ws_manhu/DEF-000123",
  "key": "DEF-000123",
  "workspace": "ws_manhu",
  "panelCwd": "D:/projects/manager-ws",   // 看板在哪
  "runCwd": "D:/projects/module-a-ws",    // 实际执行在哪
  "subsystem": "SSYS-000003",            // affects 到的子系统 key
  "sessionId": "…",
  "attempt": 2,
  "startedAt": "2026-11-07T01:30:00.000Z",
  "endedAt": null,
  "status": "running",
  "headBefore": "3f2a1c9",
  "dirtyBefore": [],
  "commit": null,
  "error": null
}
```

`status`：`running` / `fixed` / `blocked` / `gave-up` / `conflict` / `timeout` / `no-route` / `ambiguous`。

派生规则（不额外落盘）：

| 需要知道 | 算法 |
| --- | --- |
| 是否正在跑 | 该 key 最后一条 `running` 且 `sessionId` ∈ `getRunningRpcSessionIds()` |
| 试了几次 | 该 key 的记录数（`attempt` 取最大） |
| 需要人工 | `status ∈ {blocked, gave-up}`，或记录数 ≥ `maxAttempts` |
| 冷却中 | 最后一条 `endedAt` 距今 < `cooldownMin` |
| 崩溃残留 | `running` 但进程启动晚于 `startedAt` → 归档 `timeout` |

清空方式对使用者自然：删掉对应行 = 重置那条缺陷的自动化状态。

## 7. 一轮的判定顺序

```
pump(target):
  if target 不是当前打开的项目           → return     # 跟项目走
  if 该 target 的泵正在跑                → return     # 单飞
  if 上一轮距今 < intervalSec            → return
  if 进程租约不是自己                     → return
  if 该 workspace 有 running 会话         → return     # “最多一个”
  rows = runView(view)                               # modified_at 升序，最老优先
  for row of rows:
     st = derive(row.key)
     if st.running / st.blocked / st.cooldown / st.attempts >= max → skip
     route = resolveRoute(row)                        # affects → 子系统 → routes
     if !route → 记 no-route / ambiguous（不派发，面板标出）；continue   # 换下一条
     return dispatch(row, route)                      # 只派一条
```

**关键：路由失败不阻塞队列。** 一条缺陷缺子系统，不该让其它模块的缺陷跟着停。

`resolveRoute` 的顺序：

```
1. links = list_traces(key) 中 linkType / inverseLinkType === affects
2. 没有 → no-route（缺子系统）
3. 对端实体的 key 查 routes；未命中再看 name
4. 多条 affects：逐个查
     全部命中且同一目录  → 用该目录
     命中不同目录        → ambiguous（多子系统）
     一个都没命中        → no-route（缺路由）
```

## 8. 会话内的契约

`.pi/prompts/defect.md`，占位符由泵填入（缺陷全文与关联摘要一并给出，省得会话重复读）：

```
你在处理缺陷 {{key}}（来自 {{workspace}}）。

【缺陷】{{name}}
【优先级】{{priority}}
【描述】{{description}}
【关联】{{tracesSummary}}

仓库：{{runCwd}}（提交到 {{branch}}）

要求：
1. 只改这一条缺陷需要的代码，不要顺手重构无关部分。
2. 一个提交，提交信息以 {{key}} 开头。
3. 在本目录执行 git commit，提交到 {{branch}}。
4. 回答最后两行必须严格写成：
   SUMMARY: <一句话说明改了什么>
   COMMIT: <短 hash>
   修不了就只写一行：BLOCKED: <原因>
```

会话**不写实体**：solution 与状态由泵在确认 `COMMIT` 对应提交确实存在之后写入。

## 9. 失败与恢复

| 结束方式 | 判定 | 处理 |
| --- | --- | --- |
| 有 `COMMIT` 且提交存在，泵写入并推进成功 | `fixed` | 下一轮继续 |
| 回答含 `BLOCKED:` | `blocked` | 停止自动派发（人已知原因，再试是浪费） |
| 无 `COMMIT` 或提交不存在 | 计一次失败 | 冷却后重试，直到 `maxAttempts` |
| 会话超时 | `timeout` | 同失败 |
| 泵推进时 `CONCURRENT_WRITE_CONFLICT` | `conflict` | 不回写、不重试覆盖，计一次失败；**已提交的 commit 不撤回**（要人决定） |
| 解析不出路由 | `no-route` | 不派发，面板标「缺子系统 / 缺路由」 |

**回滚（只回滚自己碰过的）**：

```
touched = git status --porcelain(失败后) - dirtyBefore(派发前)
对 touched 里每个路径：checkout -- <path>；新增文件 clean -f -- <path>
```

不用 `git reset --hard`：它会连人的未提交改动一起抹掉。判断不了（HEAD 被移动 = 有人在提交）→ 停手标「需要人工」，不动工作区。

## 10. 并发三层

| 层 | 手段 | 防的是 |
| --- | --- | --- |
| 进程 | `~/.pi/agent/watch/owner.lock`（沿用 `scheduled-tasks/lease.ts` 写法） | 开发服务器与桌面端各跑一遍 |
| 工作区 | `runningByWorkspace: Map<workspace, watchId>` + running 判定 | 同工作区两个会话同时改证据链 |
| 缺陷 | run 日志 `status=running` | 同一缺陷重复派发 |

锁的键是 **entity 工作区**，不是模块目录：两个子系统共用一个工作区时仍然串行。

## 11. 界面上看得见什么

- **会话**：标题带 key（`DEF-000123`），侧栏标「自动」；
- **待办面板行尾角标**：`处理中` / `需要人工` / `重试 2/3` / `缺子系统` / `缺路由` / `多子系统`；
- **面板头部**：「暂停守护」开关（只停派发，不杀运行中的会话）；
- 所有标记只在本地叠加，**不写进 entity**。

## 12. 依赖与前置

| 依赖 | 谁 | 没有它时的行为 |
| --- | --- | --- |
| 缺陷 `affects` 子系统 | Dave / 底座 | 全部候选判 `no-route`，面板逐行标「缺子系统」；功能不上线，也不猜；子系统实体需可读（`list_traces` 能带出对端） |
| 模块项目已配 MCP / skills | 已有约定 | 会话读不到关联信息时按失败处理（不静默降级） |

## 13. 明确不做

- 不做全局“守护项目清单”（跟项目走，不另立配置）；
- 不做多缺陷并行（同工作区固定一个）；
- 不做 push / PR（只提交本地主干）；
- 不做自动撤回已提交的 commit；
- 不做基于名称/描述等文本的“猜路由”（宁可标缺路由，也不把代码改到错误的仓库）。

## 14. 测试计划

| 用例 | 断言 |
| --- | --- |
| 有 running 会话 | 不派发，不写日志 |
| 最老优先 | 三条 CONFIRMED，派 `modified_at` 最早那条 |
| 缺子系统 | 记 `no-route`，**继续看下一条**，后面的缺陷仍会被派发 |
| 子系统无路由 | 同上 |
| 一条缺陷 affects 两个子系统、映射到不同仓库 | 记 `ambiguous`，不派发，标「多子系统」 |
| 一条缺陷 affects 两个子系统、映射到同一仓库 | 正常派发到该仓库 |
| 路由缓存 | 同一 key 两轮内只解析一次 `affects`；关联变化后缓存失效 |
| 路由跨模块 | 同一视图两条缺陷分属 A/B，各自派到对应 `runCwd` |
| 失败 3 次 | 第 4 轮跳过，`derive` 报 `gave-up` |
| 会话返回 BLOCKED | 记 `blocked`，不再重试 |
| 有 COMMIT 但提交不存在 | 计失败，不写 solution |
| 泵推进冲突 | 记 `conflict`，提交保留，工作区不清理 |
| 回滚 | `dirtyBefore` 的文件失败后保持原样；只回滚 `touched` |
| 崩溃残留 | 重启后 `running` 归档 `timeout`，不永久占锁 |

（`runView`、`startRpcSession`、`git` 全部依赖注入替身：测试不碰真端点、真仓库。）

## 15. 分期

**M1**：路由（子系统→目录）+ 泵 + run 日志 + 单飞 + 角标 + 暂停开关 + 泵写 solution/推进。
不做自动回滚（失败就停手标人工）、不做通知。

**M2**：路径级回滚、失败分类细化、通知、跨轮统计。

> 前置：M1 开工前，子系统关联要能读到（哪怕只在一个测试空间里）。

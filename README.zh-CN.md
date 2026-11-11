# Entity Assistant

[English](./README.md) | **简体中文**

Entity Assistant 是一个本地桌面工作台，围绕一套实体台账展开：需求与答复（`SR`、`SSR`）、变更与缺陷（`MR`、`Defect`），以及它们之间的追溯关系。

台账既不在本仓库里，也不在 App 里。每条记录都存在一个独立的基础服务中，App 通过 MCP 访问它，端点由每个项目在自己的 `.pi/mcp.json` 里声明。App 是客户端：读台账、渲染台账，只有你要求时才写。

这个 App 把三个项目打成一个可安装的包：

| 组成 | 提供什么 |
| --- | --- |
| [pi](https://github.com/earendil-works/pi) | Agent：模型、工具、会话 |
| [agegr/pi-web](https://github.com/agegr/pi-web) | Web 界面：对话、会话、文件、设置 |
| [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) | 桌面壳：Tauri 窗口、内置 Node.js 服务、updater 机制 |

## 实体能力

工作台今天对实体台账做了什么，以及每件事的代码在哪。做到哪一步就写哪一步，不四舍五入。

| 能力 | 状态 | 代码位置 |
| --- | --- | --- |
| 经 MCP 读写台账（`get`、`list`、`create`、`update`、`promotion`、`link`、`unlink`、`list_traces`、`get_metadata`、`list_types`、`list_workspace_members`、`about_me`） | 已实现。对话里由会话暴露的工具调用；面板不经对话，直接走 JSON-RPC 调同一批工具 | `lib/mcp-call.ts`（只支持 HTTP 端点，`${VAR}` 从服务端自己的环境展开）、`app/api/entity/**` |
| 回复里的 `entity-item:` 链接在对话旁打开记录 | 已实现。完整形式 `entity-item:<server>/<workspace>/<key>`；短形式 `entity-item:<key>`（沿用上一次的通道）；可带 `?instanceId=` | `lib/entity-opener.ts`、`lib/entity-links.ts`、`lib/entity-link-extension.ts`、`components/EntityPanel.tsx` |
| 回答链接的是哪个环境（已验真 / 未验真 / 降级） | 已实现，包括声明与实到服务不一致时的 409 `instance-mismatch` | `lib/entity-identity.ts`、`lib/mcp-call.ts` 的 `readServerIdentity`、`app/api/entity/route.ts`；[设计说明](./docs/agents/entity-identity.md) |
| 实体详情面板：字段表单（含 revision 冲突处理）、关系挂接、追溯、空间成员 | 已实现。哪些字段可写由类型的元数据与你的角色决定，不是写死的清单；最终以服务端为准 | `components/EntityPanel.tsx`、`lib/entity-permissions.ts`、`app/api/entity/link/**`、`app/api/entity/traces/**`、`app/api/entity/members/route.ts` |
| 「依赖已失效」提示：某条依赖已离开它被要求的状态 | 已实现，且只在读侧。每次打开面板按依赖的当前状态重算，不存任何标记（存一个 `suspect` 就是第二份、也更旧的真相） | `lib/entity-dependencies.ts`、`components/EntityPanel.tsx` |
| 待办视图：一条视图 = 一次 `list` 的结果摊成表 | 已实现。在 `<项目>/.pi/views.yaml` 里声明（DQL、列、排序、分页、分组、提醒），每次请求重读；一条配置坏只影响它自己 | `lib/views/config.ts`、`lib/views/group.ts`、`lib/views/order-by.ts`、`lib/views/page.ts`、`app/api/views/route.ts`、`components/ViewsPanel.tsx`、`components/ProjectViewMenu.tsx` |
| 视图派发：把视图里待处理的实体交给本地项目 | 已实现。配了 `watch:` 的视图，后台每 60 秒取最老的一条认领并交给指定项目的会话，同一个项目同时只跑一个；一次尝试没落地就停到视图声明的 `manual` 态，不再自动重试 | `lib/views/watch/core.ts`、`lib/views/watch/pump.ts`、`lib/views/watch/limit.ts`、`lib/views/watch/index.ts`，由 `instrumentation-node.ts` 启动；[配置指南](./docs/entity/工作台视图的配置指南.md) |
| 领域事件订阅唤醒会话（SSR-000097 M1） | **部分实现，只到 M1。** `.pi/events.yaml` 按会话声明订阅；每个 `(server, workspace)` 一条连接，服务端粗过滤、客户端精确匹配、合批，然后 `action: wake` 恢复该会话并注入渲染好的提示词，让它跑一轮 | `lib/events/config.ts`、`lib/events/connection.ts`、`lib/events/match.ts`、`lib/events/batch.ts`、`lib/events/delivery.ts`、`lib/events/inject-text.ts`、`lib/events/runtime.ts`、`app/api/events/subscriptions/route.ts`、`components/SessionSidebar.tsx` |
| `action: notify`（M2） | **未实现。** 这样写的规则会被报成暂停，原因就是这句 | `lib/events/runtime.ts` |
| 会话正在跑时把批次排队、跑完再投（M2） | **未实现。** 该批次记为跳过，也不会打断正在跑的一轮 | `lib/events/delivery.ts` |

## 主要功能

- 按项目浏览和继续历史 Pi 会话，无需查找终端历史或 `.jsonl` 文件。
- 在桌面窗口中与 Agent 实时对话，查看思考、工具调用、上下文用量、成本和压缩状态。
- 从历史消息继续分支，或将会话 Fork 为独立会话。
- 不属于任何项目的 Chat：每个有自己的目录，并用一套策略把它与 shell 隔开，直到你手动解锁（[说明](./docs/agents/fork-chat-workspace.md)）。
- 管理模型、OAuth/API Key、自定义模型配置、Skills、Plugins 和内置子 Agent。
- 在侧边栏切换 Git worktree、浏览项目文件，并打开工作区终端。
- 定时任务：按计划（每小时、每天、每周、自定义 cron 或仅一次）在新会话里运行保存好的提示词。App 运行期间（窗口收起到托盘也算）就会执行，默认只读工具，睡眠错过的运行会补跑一次，运行结束会通知你（[规格](./docs/scheduled-tasks-spec.md)）。
- 预览源码、Diff、Markdown、图片、音频、PDF 和 DOCX；在沙箱 iframe 中渲染内联 HTML/SVG/React 预览。
- 深色与浅色主题、会话自动命名、完成提示音和运行状态恢复。
- 通过端到端加密的中继用手机跟随和操作会话，电脑不必开端口（[设计](./docs/remote-relay.md)）；Tailscale 远程访问仍作为可选项保留。

![Entity Assistant 浅色模式界面](./docs/screenshots/pi-agent-light.webp)

![Entity Assistant 深色模式界面](./docs/screenshots/pi-agent-dark.webp)

**[⬇️ 下载 Entity Assistant（macOS / Windows / Linux）](https://github.com/abcwyc/pi-agent-desktop/releases)**

发布仓：[abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop/releases)。本仓库是它的 fork，自己不发 Release，所以下载按钮、Release 说明和安装包都在 `abcwyc/pi-agent-desktop`。

## 安装与使用

### 安装桌面 App

发布版本可从 [GitHub Releases](https://github.com/abcwyc/pi-agent-desktop/releases) 下载：

- Apple Silicon Mac：下载 `aarch64.dmg`，打开后将 App 拖入 `Applications`。正式 Release 不构建 Intel Mac 版本。
- Windows x64：下载名称以 `x64-setup.exe` 结尾的安装程序并运行。安装器会在需要时安装 Microsoft WebView2。
- Linux x64：下载 `amd64.deb`，用发行版自带的包管理器安装。社区还维护了一个 [flatpark.org](https://flatpark.org/apps/io.github.abcwyc.pi-agent-desktop/) 上的 Flatpak 版本——不是官方发布，但 Flatpak 兼容大多数发行版，也会帮你处理更新。

正式 Release 支持运行 macOS 11 或更高版本的 Apple Silicon Mac、Windows 10/11 x64，以及使用 WebKitGTK 4.1 和 GTK 3 的 Linux x64 发行版。桌面包内包含运行 Entity Assistant 所需的 Next.js 服务、Node.js runtime 和当前版本的 Pi SDK，打开 App 时会自动启动本地服务，不需要用户另开终端、安装 Node.js 或单独启动 Web Server。

> **Homebrew 目前不是可用的安装方式。** 本仓库的 `Casks/entity-assistant.rb` 仍钉在 0.8.1，且下载地址指向一个不发 Release 的仓库，所以从这个 tap 执行 `brew install --cask entity-assistant` 会失败。请改用 `abcwyc/pi-agent-desktop` 的 DMG。修 cask 属于发布决定，不在本文范围内。

> 安装 Entity Assistant 后，可以直接使用 App 中的功能；但它不会在系统全局安装 `pi` 命令。如果还需要在终端中使用 Pi CLI，请按照 [pi 项目](https://github.com/earendil-works/pi) 的说明单独安装。

> **macOS 首次打开被拦截**：macOS 版本目前没有 Apple Developer ID 签名和公证，首次打开时 Gatekeeper 可能提示“无法验证开发者”或“已损坏，无法打开”。可以在「系统设置 › 隐私与安全性」中点「仍要打开」，或在终端执行：
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Entity Assistant.app"
> ```

升级方式是用新包覆盖安装。会话、模型设置和凭据都在 `~/.pi` 里，覆盖安装不会动它们。App 内的升级按钮已在 `fe47efa` 移除，所以现在 App 里没有任何下载或安装更新的入口：没有任何地方调用 `installLatestDesktopRelease`（`lib/desktop-updater.ts` 仍导出 `isTauriDesktop` 供界面使用），也没有任何地方请求 `app/api/updates/`。`src-tauri/tauri.conf.json` 仍声明了一个 updater 端点 `stormwine1986/pi-agent-desktop/releases/latest/download/latest.json`，而该仓库没有 Release，所以它是 404 —— 本地构建本来也不注册 updater 插件；改这个端点属于发布决定，不是文档修正。详见 [桌面升级与发布说明](./docs/desktop-updates.md)。

### 把应用指向你的台账

台账数据来自项目在 `.pi/mcp.json` 里声明的 MCP 端点。项目文件与全局 `~/.pi/agent/mcp.json` 都会读，项目里的优先。形状示例（占位符）：

```json
{
  "mcpServers": {
    "entity-base": {
      "url": "http://<entity-host>:3100/entity/mcp"
    }
  }
}
```

这个名字（上面的 `entity-base`）就是 `.pi/views.yaml` 和 `.pi/events.yaml` 里 `server` 写的东西，也是 `entity-item:` 链接第一个斜杠前面那一段。凭据不要写进文件：App 会从服务端自己的环境展开 `${VAR}`，token 就是这么存的。

面板、视图派发泵和事件运行时只支持 HTTP 类型的条目；`command`/`stdio` 条目在这里会被拒绝，而不是被拉起。Agent 自己的会话走完整的 MCP host，两种都能用。

### 使用现有 Pi 数据

Entity Assistant 默认读取 Pi 的本地数据目录：

```text
~/.pi/agent/
```

其中会话通常保存在：

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

如果电脑上已经使用过 Pi，安装 App 后可以继续浏览原有会话、模型和认证配置。可以通过 `PI_CODING_AGENT_DIR` 指向其他 Pi 数据目录。

模型密钥和会话数据保留在用户电脑上；文件浏览 API 仅允许访问当前会话、所选项目和显式授权的工作目录。

## HTTP 代理

Entity Assistant 的服务端模型和 API 请求支持标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。例如从终端启动开发服务时：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npm run dev
```

## 本地开发

### 环境要求

- macOS 11+（Apple Silicon）、Windows 10/11 x64，或使用 WebKitGTK 4.1 与 GTK 3 的 Linux x64
- Node.js 22.19 或更高（见 `package.json` 的 `engines`）
- npm
- Rust：CI 用**当前 stable** 工具链构建（`.github/workflows/ci.yml` 与 `release.yml` 里的 `dtolnay/rust-toolchain@stable`），而 `src-tauri/Cargo.toml` 的 `rust-version = "1.85.0"` 是本地构建的下限。新 stable 可能引入新 lint，被 `cargo clippy -- -D warnings` 当成错误（1.99 的 `needless_option_as_deref` 就是），这种情况修 lint，不要把工具链钉死，否则 CI 与本地就各说各话
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ Build Tools 与 WebView2
- Linux：GTK/WebKitGTK 开发包

### 启动 Web 开发服务器

```bash
npm install
npm run dev
```

开发服务器运行在 [http://localhost:30141](http://localhost:30141)，不会自动打开浏览器。`npm run web` 启动同一个 loopback 服务器，并在就绪后用桌面浏览器打开 `http://127.0.0.1:30141`。在 WSL 中打开的是 Windows 浏览器。见 [Web profile](./docs/web-profile.md)。

日常开发期间不要运行 `next build` 或 `npm run build`。这些命令会写入 `.next/`，可能干扰正在运行的开发服务器；正式构建由桌面准备脚本或 CI 完成。

### 网络暴露（局域网）

`npm run dev` 和 `npm start` 只监听 `127.0.0.1`。`npm run dev:lan`、`npm run start:lan` 与 `pi-web -H 0.0.0.0` 会监听所有网卡。Entity Assistant 能以你的身份执行 shell 命令（终端标签和 agent 自身工具）并读取文件，因此**任何能访问该端口的人都拥有同样的权限**。使用局域网模式前请先设置密码：

```bash
PI_WEB_PASSWORD='换成足够长的口令' npm run dev:lan
```

设置 `PI_WEB_PASSWORD` 后，浏览器首次访问需要输入密码，连续失败会被限流。连接仍是明文 HTTP，请放在 HTTPS 或可信 VPN 之后；如需用 IP 以外的域名访问，用 `PI_WEB_ALLOWED_HOSTS`（逗号分隔）放行。未设密码时，启动器拒绝监听非回环地址；在可信网络上可以设 `PI_WEB_ALLOW_UNAUTHENTICATED=1` 强制启动，启动时会打印警告。桌面 App 不受影响：它只绑定回环地址，并用每进程 token 认证 WebView。

### 启动桌面开发模式

```bash
npm run desktop:dev
```

该命令会启动现有 Next.js 开发服务器，并使用 Tauri 原生窗口打开页面，不生成安装包。

### 常用检查

```bash
# Node 测试：app、lib、scripts、components、hooks、relay、relay-shell、public。
# pretest 先比对已装依赖与 lockfile。
npm test

# TypeScript
node_modules/.bin/tsc --noEmit

# ESLint 与品牌保护测试
npm run lint

# 与 pi-web 上游的偏离度：区分「样式类」与「结构类」改动
npm run drift

# 浏览器回归套件（需要 `npx playwright install chromium` 和一个构建；见 e2e/README.md）
npm run test:e2e

# Rust/Tauri
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# 发布工具自身测试
npm run test:release-tools
```

## 桌面打包

```bash
npm run desktop:build
```

这个入口就是三步：先 `npm run desktop:prepare`，再 `npm run release:manifest`，最后 `tauri build`。`tauri build` 把 `npm run desktop:check-inputs` 作为 `beforeBuildCommand`，所以直接敲 `npx tauri build` 会被拒绝，而不是把 `src-tauri/resources` 里恰好剩下的东西打进去。

`npm run desktop:prepare`（`scripts/prepare-desktop.mjs`）按顺序做五件事：

1. **清掉上一次的产物**：`.next-desktop/`、`src-tauri/resources/server`、`src-tauri/resources/node`、macOS 用的 helper app，以及 `src-tauri/target/<profile>/{resources,bundle}`。上一次的副本留在那里，构建就会把自己打进去。
2. **构建并 trace**：在 `.next-desktop` 里做 standalone 构建（`PI_WEB_DESKTOP_BUILD=1` 换掉 `distDir`），然后铺开服务端、每个 `@earendil-works` 包的完整 `dist/`、tracer 追不到的包（`node-pty` prebuilds、`jiti`、`quickjs-wasi`、Bedrock 的依赖闭包）、`public/`，以及当前架构的 Node.js runtime。
3. **清理被 trace 进来的 `.pi/`**：文件 tracer 从本仓库自己的 `.pi/` 拖进 standalone 的东西会被删掉（`scripts/packaged-payload.mjs`）。
4. **断言两次**：一次在 `.next-desktop/standalone`，一次在 `src-tauri/resources`，位置在 `tauri build` 能打包之前。规则按后果判定，不看 tracer 行为：不能有 `.pi/` 路径、不能有 MCP bearer token（payload 规则认的是 `ak_` 这一族密钥）、不能有带封装的私钥、不能嵌套 `resources/server` 或残留 `src-tauri/target`。命中就 throw——没有 `--skip`、没有环境变量、没有「照常继续」（DEFECT-000089）。被放行的只有 npm 自带文档里作为示例印出来的私钥文本
5. **可选金丝雀**：`PAYLOAD_CANARY=1 npm run desktop:prepare` 会先放一个假的 `.pi/mcp.json`（里面是一个假的 MCP bearer token，且只在本仓库没有 `.pi/` 时创建），报告 tracer 有没有把它拖进来，并仍然在它残留进 payload 时失败。干净的 CI checkout 没有 `.pi/`，不放金丝雀这条断言就是空过。

铺好之后、发出去之前还有两道闸门：

- `npm run desktop:check-payload` 不重新构建，直接对已铺好的树再跑一遍同一个断言；`node scripts/check-packaged-payload.mjs --root <dir>` 可以指向别的树。
- `npm run desktop:verify` 用包内自带的 Node runtime 启动铺好的服务，验证 Code mode 的 QuickJS 沙箱和终端在包里真的能用——这两处加载的文件正是 tracer 追不到的。

`npm run release:manifest` 把「这次构建是谁」写进 `src-tauri/resources/component-versions.json`——`gitCommit`、`gitCommitShort`、`gitBranch`、`gitDirty`、`builtAt`、`node`、`buildId`——并立刻回读校验：清单与 `git rev-parse`、`git status` 或 `.next-desktop/BUILD_ID` 不一致，就在这里失败，而不是等安装之后。`desktop:check-inputs` 会在 `tauri build` 时再拿这份记录与 HEAD 比对一次，所以别的构建铺出来的输入会被拒绝（TASK-000111）。

### 清单顺序：先 manifest 再 verify

`npm run release:manifest` 写清单，`npm run release:verify` 校清单。先写后校，并且在已提交的树上要预期一个特定失败：提交生成的清单会移动 HEAD，于是 `release:verify` 报

```text
gitCommit is <sha> but HEAD is <sha>
```

这是检查按设计在工作（SSR-000096：Release 必须能追溯到它构建自的那个 commit），不是缺陷。`release:verify` 还会访问 GitHub，要求内置的 `pi`、`pi-web` 精确匹配各自最新稳定 Release（除非 `scripts/release-component-pins.json` 里写了有意为之的 pin），要求 `pi-agent-desktop` 比已发布的最新版**更新**，并拒绝脏工作区。

## 上游同步与 Release

仓库包含两条串联的自动化工作流：

- [`component-updates.yml`](./.github/workflows/component-updates.yml)：每天检查 `pi` 和 `pi-web` 的稳定 Release。发现新版后，**先**把上游改动集与 [`scripts/fork-ownership.json`](./scripts/fork-ownership.json) 记录的「本仓库改过的上游文件」求交集，再合并 Tag、更新依赖和组件清单，并运行完整门禁（`npm test`、`tsc`、`lint`、真实 standalone 构建）。
  - 交集为空 → 直接提交 `main` 并触发发布；
  - 命中高/中风险文件 → 推送 `sync/pi-web-<tag>` 分支并开 PR，附上边界报告，**不**触发发布。合并该 PR 才会发版。
- [`release.yml`](./.github/workflows/release.yml)：收到组件同步工作流的显式触发后，串行构建 Apple Silicon (`aarch64`) DMG、Linux x64 `.deb` 和 Windows x64 NSIS `-setup.exe`，不构建 Intel Mac 版本。Release 在三个平台的 updater 签名文件、`latest.json` 和组件清单全部上传完成前保持草稿状态 —— `manifest` job 依赖**整个**构建矩阵，任一平台失败就不会转正。构建失败会创建/更新 `release-failure` Issue。

上游同步使用 Git 合并，因此本仓库维护的 Entity Assistant 品牌、设置入口和升级逻辑会作为本地修改保留。合并冲突会让工作流停止——这是安全的失败方式。真正危险的是**无冲突但语义错误**的合并：上游改了本仓库也改过的区域，Git 干净地合上了，测试也全绿。上面的边界求交就是为此设置的，规则见 [维护边界说明](./docs/ownership-boundaries.md)。

同步失败会自动创建/更新 `component-sync-failure` Issue，不会静默积压。

正式发布前需要配置：

- Tauri updater 公私钥；
- 面向外部用户分发时所需的 Apple Developer ID 签名和公证；
- 面向 Windows 外部用户分发时建议配置 Authenticode 代码签名证书；未签名的 `.exe` 可能触发 SmartScreen 提示。

## 项目结构

```text
app/                    Next.js App Router：页面与 /api 路由（agent、sessions、entity、views、events、mcp 等）
bin/                    pi-web CLI 入口：参数、Node 版本守卫、进程生命周期
components/             React 界面：对话、侧边栏、设置、实体面板、视图面板、artifacts
demo/                   静态、带 mock 的界面副本，发布到 GitHub Pages
desktop/                桌面专用件：服务启动器、Tauri 前端占位页、helper Info.plist
docs/                   设计说明，以及 docs/agents/ 下按主题拆分的工作文档
e2e/                    Playwright 浏览器回归测试
hooks/                  会话流、音频、拖放、主题等客户端状态
lib/                    服务端与客户端逻辑
  events/               事件订阅：配置、连接、合批、匹配、投递
  views/                待办视图：配置、分组、排序、分页
    watch/              派发泵：认领、提示词渲染、按项目的运行闸门、限额
  scheduled-tasks/      调度器、运行器、cron、运行索引、进程租约
  relay/                端到端加密中继的客户端（手机隧道）
public/                 静态资源，含内置的预览 runtime
relay/                  中继服务端（Docker、compose），为手机流量做隧道
relay-shell/            由中继主机提供的手机 shell
scripts/                打包、payload 闸门、组件清单与校验、偏离度、预览 runtime
src-tauri/
  capabilities/         Tauri 权限配置
  installer-hooks.nsh   NSIS 安装器钩子：覆盖安装、运行中 runtime 检查
  resources/            铺好的服务端、内置 Node runtime、component-versions.json
  src/                  桌面窗口、本地服务、托盘、updater 注册
.github/workflows/      CI、每日组件同步、桌面 Release、demo 页面
instrumentation.ts      Next.js instrumentation 入口（Edge 安全）
instrumentation-node.ts 仅 Node 的启动项：HTTP dispatcher、调度器、视图派发泵、事件运行时、中继
proxy.ts                请求闸门：允许的主机、密码认证、限流、中继标记
```

## 相关文档

- [维护边界说明](./docs/ownership-boundaries.md) — 与 `pi-web` 上游的分工、改共享文件的规则、自动同步的判定逻辑
- [桌面升级与发布说明](./docs/desktop-updates.md)
- [工作台视图的配置指南](./docs/entity/工作台视图的配置指南.md) — `.pi/views.yaml` 逐字段说明
- [Git Worktree 使用说明](./docs/worktrees.zh-CN.md)
- [定时任务规格](./docs/scheduled-tasks-spec.md)
- [远程中继设计](./docs/remote-relay.md)
- [工作区终端](./docs/terminal.md)
- [Pi Session 与项目架构说明](./AGENTS.md)

## 署名与许可证

Entity Assistant 的桌面集成由 `pi-agent-desktop` 提供，核心能力和 Web 界面分别来自 [earendil-works/pi](https://github.com/earendil-works/pi) 与 [agegr/pi-web](https://github.com/agegr/pi-web)。感谢这些项目及其贡献者。

本仓库根目录代码遵循 [`LICENSE`](./LICENSE) 中的 MIT License。三个组成项目的代码和依赖同时受各自仓库许可证约束；复制、修改或重新分发时请保留相应版权与许可声明。

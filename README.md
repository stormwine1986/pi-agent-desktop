# Entity Assistant

**English** | [简体中文](./README.zh-CN.md)

Entity Assistant is a local desktop workbench for an entity ledger — request and requirement records (`SR`, `SSR`), change and defect records (`MR`, `Defect`), and the traceability links between them.

The ledger itself is not stored in this repository and not inside the app. Every record lives in a separate base service that the app reaches over MCP, using an entry that each project declares in its own `.pi/mcp.json`. The app is the client: it reads the ledger, renders it, and writes only when you ask it to.

The app packages three projects into one installable build:

| Component | What it provides |
| --- | --- |
| [pi](https://github.com/earendil-works/pi) | the agent: models, tools, sessions |
| [agegr/pi-web](https://github.com/agegr/pi-web) | the web UI: chat, sessions, files, settings |
| [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) | the desktop shell: Tauri window, bundled Node.js server, updater plumbing |

## Entity Capabilities

What the workbench does with an entity ledger today, and where each piece lives. "Partial" is spelled out rather than rounded up.

| Capability | State | Where it lives |
| --- | --- | --- |
| Read and write the ledger over MCP (`get`, `list`, `create`, `update`, `promotion`, `link`, `unlink`, `list_traces`, `get_metadata`, `list_types`, `list_workspace_members`, `about_me`) | Implemented. The agent calls the tools a session exposes; the panels call the same tools directly over JSON-RPC, without a conversation | `lib/mcp-call.ts` (HTTP entries only, `${VAR}` expanded from the server's environment), `app/api/entity/**` |
| `entity-item:` links in a reply open the record beside the chat | Implemented. Full form `entity-item:<server>/<workspace>/<key>`, short form `entity-item:<key>` (last channel used), optional `?instanceId=` | `lib/entity-opener.ts`, `lib/entity-links.ts`, `lib/entity-link-extension.ts`, `components/EntityPanel.tsx` |
| Which environment answered a link ("verified" / "未验真" / "degraded") | Implemented, including the 409 `instance-mismatch` answer when the declaration and the reached server disagree | `lib/entity-identity.ts`, `readServerIdentity` in `lib/mcp-call.ts`, `app/api/entity/route.ts`; [design note](./docs/agents/entity-identity.md) |
| Entity detail panel: field form with revision-conflict handling, relation links, traces, workspace members | Implemented. Which fields are writable comes from the type's metadata and your roles, not from a hard-coded list; the server keeps the last word | `components/EntityPanel.tsx`, `lib/entity-permissions.ts`, `app/api/entity/link/**`, `app/api/entity/traces/**`, `app/api/entity/members/route.ts` |
| "依赖已失效" guard: an entity whose required dependency has left the required state | Implemented, read-side. Recomputed every time the panel opens from the dependency's current state; nothing is stored (a stored `suspect` flag would be a second, staler truth) | `lib/entity-dependencies.ts`, `components/EntityPanel.tsx` |
| To-do views: a view is one `list` call rendered as a table | Implemented. Declared in `<project>/.pi/views.yaml` (DQL, columns, ordering, page size, groups, reminders), re-read per request, one broken view never blanks the others | `lib/views/config.ts`, `lib/views/group.ts`, `lib/views/order-by.ts`, `lib/views/page.ts`, `app/api/views/route.ts`, `components/ViewsPanel.tsx`, `components/ProjectViewMenu.tsx` |
| Watch dispatch: hand a pending record from a view to a local project | Implemented. A view with `watch:` gets its oldest pending item claimed and handed to a session in the configured project, one at a time per project, in the background every 60 s; a failed attempt parks the item in the view's `manual` state and is never retried automatically | `lib/views/watch/core.ts`, `lib/views/watch/pump.ts`, `lib/views/watch/limit.ts`, `lib/views/watch/index.ts`, started from `instrumentation-node.ts`; [configuration guide (Chinese)](./docs/entity/工作台视图的配置指南.md) |
| Domain event subscriptions wake a session (SSR-000097 M1) | **Partial — M1 only.** `.pi/events.yaml` declares per-session subscriptions; one connection per `(server, workspace)`, server-side coarse filter, client-side exact match, coalescing, then `action: wake` resumes that session and injects a rendered prompt so it runs one turn | `lib/events/config.ts`, `lib/events/connection.ts`, `lib/events/match.ts`, `lib/events/batch.ts`, `lib/events/delivery.ts`, `lib/events/inject-text.ts`, `lib/events/runtime.ts`, `app/api/events/subscriptions/route.ts`, `components/SessionSidebar.tsx`; [configuration guide (Chinese)](./docs/entity/事件订阅的配置指南.md) |
| `action: notify` (M2) | **Not implemented.** A rule asking for it is reported as paused, with that as the reason | `lib/events/runtime.ts` |
| Queue a delivered batch while the session is already running (M2) | **Not implemented.** The batch is recorded as skipped and the run is not interrupted | `lib/events/delivery.ts` |

## Features

- Browse and resume past Pi sessions by project, without digging through terminal history or `.jsonl` files.
- Talk to the agent in real time inside a desktop window, with thinking, tool calls, context usage, cost, and compaction state all visible.
- Continue from any earlier message as a branch, or fork the conversation into an independent session.
- Chats that belong to no project: each gets its own folder and a policy that keeps it off the shell until you unlock it ([notes](./docs/agents/fork-chat-workspace.md)).
- Manage models, OAuth/API keys, custom model configuration, skills, plugins, and built-in subagents.
- Switch Git worktrees from the sidebar, browse project files, and open a workspace terminal.
- Scheduled tasks: run a saved prompt in a new session on a schedule (hourly, daily, weekly, a custom cron expression, or once). They run while the app is open, even with its window hidden, default to read-only tools, catch up once after a sleep, and notify you when a run ends ([spec](./docs/scheduled-tasks-spec.md)).
- Preview source code, diffs, Markdown, images, audio, PDF, and DOCX files; render inline HTML/SVG/React previews in a sandboxed frame.
- Dark and light themes, automatic session naming, a completion sound, and restored run state.
- Follow and drive sessions from a phone through an end-to-end encrypted relay, without opening a port ([design](./docs/remote-relay.md)); Tailscale remote access stays available as an option.

![Entity Assistant light mode](./docs/screenshots/pi-agent-light.webp)

![Entity Assistant dark mode](./docs/screenshots/pi-agent-dark.webp)

**[⬇️ Download Entity Assistant (macOS / Windows / Linux)](https://github.com/abcwyc/pi-agent-desktop/releases)**

Releases: [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop/releases). This repository is a fork of it; the fork publishes no releases of its own, so the download button, the release notes, and the packaged builds all live at `abcwyc/pi-agent-desktop`.

## Installation And Usage

### Install The Desktop App

Builds are available from [GitHub Releases](https://github.com/abcwyc/pi-agent-desktop/releases):

- Apple Silicon Mac: download the `aarch64.dmg`, open it, and drag the app into `Applications`. Official releases do not build for Intel Macs.
- Windows x64: download the installer whose name ends in `x64-setup.exe` and run it. The installer pulls in Microsoft WebView2 when it is missing.
- Linux x64: download the `amd64.deb` and install it with your distribution's package manager. A community-maintained Flatpak is also available at [flatpark.org](https://flatpark.org/apps/io.github.abcwyc.pi-agent-desktop/) — not an official release, but Flatpak works across most distributions and handles updates for you.

Official releases support Apple Silicon Macs running macOS 11 or later, Windows 10/11 x64, and Linux x64 distributions with WebKitGTK 4.1 and GTK 3. The desktop package bundles the Next.js server, the Node.js runtime, and the current Pi SDK, so the local server starts with the app — no separate terminal, Node.js installation, or manually started web server is required.

> **Homebrew is not an install path today.** `Casks/entity-assistant.rb` in this repository still pins version 0.8.1 and downloads from a repository that publishes no releases, so `brew install --cask entity-assistant` from this tap fails. Install the DMG from `abcwyc/pi-agent-desktop` instead. Fixing the cask is a release decision, tracked outside this document.

> Installing Entity Assistant gives you the agent inside the app, but it does not install a global `pi` command. If you also want the Pi CLI in your terminal, install it separately by following the [pi project](https://github.com/earendil-works/pi) instructions.

> **macOS blocks the first launch**: the macOS build is not yet signed with an Apple Developer ID or notarized, so Gatekeeper may say the developer cannot be verified or that the app "is damaged and can't be opened". Click "Open Anyway" in System Settings › Privacy & Security, or run:
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Entity Assistant.app"
> ```

Upgrading means installing the new build over the installed app. Sessions, model settings and credentials live in `~/.pi` and are not touched by an overwrite install. The in-app upgrade button was removed in `fe47efa`, so nothing in the app downloads or installs an update any more: nothing calls `installLatestDesktopRelease` (`lib/desktop-updater.ts`, which still exports `isTauriDesktop` for the UI) and nothing fetches `app/api/updates/`. `src-tauri/tauri.conf.json` still declares an updater endpoint under `stormwine1986/pi-agent-desktop/releases/latest/download/latest.json`, which answers 404 because that repository has no releases — local builds do not register the updater plugin either way, and repointing that endpoint is a release decision, not a documentation fix. See [Desktop updates and releases](./docs/desktop-updates.md).

### Point The App At Your Ledger

Entity data comes from whatever MCP endpoint a project declares in `.pi/mcp.json`. Both the project file and the global `~/.pi/agent/mcp.json` are read; the project entry wins. Example shape, with placeholders:

```json
{
  "mcpServers": {
    "entity-base": {
      "url": "http://<entity-host>:3100/entity/mcp"
    }
  }
}
```

The name (`entity-base` above) is what `.pi/views.yaml` and `.pi/events.yaml` refer to as `server`, and what an `entity-item:` link writes before the first slash. Keep credentials out of the file: the app expands `${VAR}` from the server's own environment, which is how tokens are stored.

Panels, the view watch dispatcher and the event runtime only speak HTTP entries; a `command`/`stdio` entry is refused there rather than spawned. The agent's own sessions use the full MCP host, so they can use either kind.

### Use Existing Pi Data

Entity Assistant reads Pi's local data directory by default:

```text
~/.pi/agent/
```

Sessions normally live under:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

If you have used Pi on this machine before, the app picks up your existing sessions, models, and authentication after installation. Set `PI_CODING_AGENT_DIR` to point at a different Pi agent data directory.

Model keys and session data stay on your machine. The file-browsing API only allows access to the current session, the selected project, and explicitly authorized working directories.

## HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables. For example, when starting the dev server from a terminal:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npm run dev
```

## Local Development

### Requirements

- macOS 11+ (Apple Silicon), Windows 10/11 x64, or Linux x64 with WebKitGTK 4.1 and GTK 3
- Node.js 22.19 or newer (`engines` in `package.json`)
- npm
- Rust: CI builds with the **current stable** toolchain (`dtolnay/rust-toolchain@stable` in `.github/workflows/ci.yml` and `release.yml`), while `src-tauri/Cargo.toml` declares `rust-version = "1.85.0"` as the floor for a local build. A new stable release can add a lint that `cargo clippy -- -D warnings` turns into an error (1.99 did, with `needless_option_as_deref`); fix the lint instead of pinning the toolchain, or CI and local builds disagree
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2
- Linux: GTK/WebKitGTK development packages

### Start The Web Dev Server

```bash
npm install
npm run dev
```

The dev server runs at [http://localhost:30141](http://localhost:30141) and does not open a browser. `npm run web` starts the same loopback server and opens `http://127.0.0.1:30141` in the desktop browser after it is ready. From WSL that is the Windows browser. See [Web profile](./docs/web-profile.md).

Do not run `next build` or `npm run build` during normal development. They write into `.next/` and can disrupt a running dev server; production builds are done by the desktop preparation script or by CI.

### Network Exposure (LAN)

`npm run dev` and `npm start` listen on `127.0.0.1` only. `npm run dev:lan`, `npm run start:lan` and `pi-web -H 0.0.0.0` listen on every interface. Entity Assistant can run shell commands (the terminal tab and the agent's own tools) and read files as you, so **anyone who can reach the port gets the same access**. Before using a LAN mode, set a password:

```bash
PI_WEB_PASSWORD='choose-a-long-passphrase' npm run dev:lan
```

With `PI_WEB_PASSWORD` set, the browser asks for it on first visit and failed attempts are throttled. The connection is still plain HTTP, so put it behind HTTPS or a trusted VPN, and use `PI_WEB_ALLOWED_HOSTS` (comma-separated) to allow a DNS name other than an IP address. Without a password the launcher refuses to listen beyond loopback; on a network you trust, `PI_WEB_ALLOW_UNAUTHENTICATED=1` starts it anyway with a warning. The packaged desktop app is unaffected: it binds to loopback and authenticates the WebView with a per-process token.

### Start Desktop Dev Mode

```bash
npm run desktop:dev
```

This starts the existing Next.js dev server and opens it in a native Tauri window, without producing an installer.

### Common Checks

```bash
# Node tests: app, lib, scripts, components, hooks, relay, relay-shell, public.
# `pretest` first compares installed packages with the lockfile.
npm test

# TypeScript
node_modules/.bin/tsc --noEmit

# ESLint plus the branding protection test
npm run lint

# Divergence from pi-web upstream, split into "styling" and "structural" changes
npm run drift

# Browser regression suite (needs `npx playwright install chromium`, and a build;
# see e2e/README.md)
npm run test:e2e

# Rust/Tauri
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# Release tooling's own tests
npm run test:release-tools
```

## Desktop Packaging

```bash
npm run desktop:build
```

That entry point is exactly three steps: `npm run desktop:prepare`, then `npm run release:manifest`, then `tauri build`. `tauri build` runs `npm run desktop:check-inputs` as its `beforeBuildCommand`, so a bare `npx tauri build` is refused rather than packaging whatever `src-tauri/resources` happens to hold.

`npm run desktop:prepare` (`scripts/prepare-desktop.mjs`) does five things, in this order:

1. **Clears the previous output**: `.next-desktop/`, `src-tauri/resources/server`, `src-tauri/resources/node`, the macOS helper app, and `src-tauri/target/<profile>/{resources,bundle}`. A stale copy is how a build packages itself.
2. **Builds and traces**: a standalone Next.js build in `.next-desktop` (`PI_WEB_DESKTOP_BUILD=1` swaps `distDir`), then stages the server, the complete runtime `dist/` of every `@earendil-works` package, the packages the tracer cannot follow (`node-pty` prebuilds, `jiti`, `quickjs-wasi`, the Bedrock SDK closure), `public/`, and the Node.js runtime for this architecture.
3. **Prunes a traced `.pi/`**: whatever the file tracer dragged in from this checkout's own `.pi/` is deleted from the standalone output (`scripts/packaged-payload.mjs`).
4. **Asserts twice**: once over `.next-desktop/standalone`, once over `src-tauri/resources`, right before `tauri build` can package anything. The rules are consequences, not tracer behaviour: no `.pi/` path, no MCP bearer token (the payload rule looks for the `ak_` key family), no armoured private key, no nested `resources/server` or `src-tauri/target`. A finding throws — there is no `--skip`, no env var and no "continue anyway" (DEFECT-000089). The only allowlisted hits are npm's own docs, which print an example private key as documentation.
5. **Optional canary**: `PAYLOAD_CANARY=1 npm run desktop:prepare` plants a fake `.pi/mcp.json` carrying a fake MCP bearer token first (only when the checkout has none), reports whether the tracer picked it up, and still fails if it survives into the payload. A clean CI checkout has no `.pi/`, so without the canary that assertion passes vacuously.

Two more gates run after staging and before anything is shipped:

- `npm run desktop:check-payload` re-runs the same payload assertion on a staged tree, without rebuilding. `node scripts/check-packaged-payload.mjs --root <dir>` points it at any other tree.
- `npm run desktop:verify` starts the staged server with its bundled Node runtime and checks that Code mode's QuickJS sandbox and the terminal actually work in the package, because both load files the tracer cannot follow.

`npm run release:manifest` records which build this is — `gitCommit`, `gitCommitShort`, `gitBranch`, `gitDirty`, `builtAt`, `node`, `buildId` — into `src-tauri/resources/component-versions.json`, and re-reads it immediately: a manifest that disagrees with `git rev-parse`, `git status` or `.next-desktop/BUILD_ID` fails there, not at install time. `desktop:check-inputs` compares that block with HEAD again at `tauri build` time, so inputs staged from a different build are refused (TASK-000111).

### Manifest Order: Manifest First, Verify Second

`npm run release:manifest` writes the manifest, `npm run release:verify` checks it. Run them in that order, and expect one specific failure on a committed tree: committing the generated manifest moves HEAD, so `release:verify` reports

```text
gitCommit is <sha> but HEAD is <sha>
```

That is the check working as designed (SSR-000096: a release must be attributable to the commit it was built from), not a defect. `release:verify` also reaches GitHub and requires the bundled `pi` and `pi-web` to match their latest stable releases exactly — unless `scripts/release-component-pins.json` carries a deliberate pin — requires `pi-agent-desktop` to be *newer* than the latest published release, and refuses a dirty tree.

## Upstream Sync And Releases

The repository contains two chained automation workflows:

- [`component-updates.yml`](./.github/workflows/component-updates.yml): checks the stable releases of `pi` and `pi-web` daily. When a new version appears, it **first** intersects the incoming upstream changeset with the "upstream files this fork has modified" recorded in [`scripts/fork-ownership.json`](./scripts/fork-ownership.json), then merges the tag, updates dependencies and the component manifest, and runs the full gate (`npm test`, `tsc`, `lint`, a real standalone build).
  - Empty intersection → commits to `main` and triggers a release.
  - High or medium risk files hit → pushes a `sync/pi-web-<tag>` branch and opens a PR with the boundary report, and does **not** trigger a release. Merging that PR is what ships a version.
- [`release.yml`](./.github/workflows/release.yml): after an explicit trigger from the component sync workflow, serially builds the Apple Silicon (`aarch64`) DMG, the Linux x64 `.deb`, and the Windows x64 NSIS `-setup.exe`. No Intel Mac build is produced. The release stays a draft until the updater signature files, `latest.json`, and the component manifest for all platforms are uploaded — the `manifest` job depends on the **entire** build matrix, so a failure on any platform keeps it from being published. Build failures create or update a `release-failure` issue.

Upstream sync uses a Git merge, so this fork's Entity Assistant branding, settings entry points, and upgrade logic survive as local modifications. Merge conflicts stop the workflow, which is the safe failure mode. The genuinely dangerous case is a **conflict-free but semantically wrong** merge: upstream changed a region this fork also changed, Git merged it cleanly, and the tests still pass. The boundary intersection above exists for exactly that case; the rules are in [Ownership boundaries](./docs/ownership-boundaries.md).

A failed sync creates or updates a `component-sync-failure` issue, so nothing piles up silently.

An official release additionally requires:

- Tauri updater key pair.
- Apple Developer ID signing and notarization for distribution to external users.
- Authenticode code signing is recommended for Windows distribution to external users; an unsigned `.exe` can trigger SmartScreen warnings.

## Project Structure

```text
app/                    Next.js App Router: pages and /api routes (agent, sessions, entity, views, events, mcp, …)
bin/                    pi-web CLI entry: options, node-version guard, process lifecycle
components/             React UI: chat, sidebar, settings, entity panel, views panel, artifacts
demo/                   Static, mock-backed copy of the UI, published to GitHub Pages
desktop/                Desktop-only pieces: server launcher, Tauri frontend stub, helper Info.plist
docs/                   Design notes, and the per-area agent docs in docs/agents/
e2e/                    Playwright browser regression tests
hooks/                  Client state: session streams, audio, drag and drop, theme
lib/                    Server and client logic
  events/               Event subscriptions: config, connection, coalescing, matching, delivery
  views/                To-do views: config, grouping, ordering, paging
    watch/              Watch dispatcher: claim, prompt rendering, per-project running gate, limits
  scheduled-tasks/      Scheduler, runner, cron, run index, process lease
  relay/                End-to-end encrypted relay client (phone tunnel)
public/                 Static assets, including the bundled preview runtime
relay/                  Relay server (Docker, compose) that tunnels phone traffic
relay-shell/            Phone shell served by the relay host
scripts/                Packaging, payload gates, component manifest and verification, drift, preview runtime
src-tauri/
  capabilities/         Tauri permission configuration
  installer-hooks.nsh   NSIS installer hook: overwrite installs, running-runtime check
  resources/            Staged server, bundled Node runtime, component-versions.json
  src/                  Desktop window, local server, tray, updater registration
.github/workflows/      CI, daily component sync, desktop release, demo pages
instrumentation.ts      Next.js instrumentation entry (Edge-safe)
instrumentation-node.ts Node-only startup: HTTP dispatcher, scheduler, watch pump, event runtime, relay
proxy.ts                Request gate: allowed hosts, password auth, throttling, relay mark
```

## Related Documents

- [Ownership boundaries](./docs/ownership-boundaries.md) — the split with `pi-web` upstream, the rules for editing shared files, and how the automated sync decides
- [Desktop updates and releases](./docs/desktop-updates.md)
- [View configuration guide](./docs/entity/工作台视图的配置指南.md) (Chinese) — `.pi/views.yaml`, per field
- [Worktrees](./docs/worktrees.md)
- [Scheduled tasks](./docs/scheduled-tasks-spec.md)
- [Remote relay](./docs/remote-relay.md)
- [Workspace terminals](./docs/terminal.md)
- [Pi session and project architecture](./AGENTS.md)

## Credits And License

The desktop integration of Entity Assistant is provided by `pi-agent-desktop`; the core capabilities and the web interface come from [earendil-works/pi](https://github.com/earendil-works/pi) and [agegr/pi-web](https://github.com/agegr/pi-web) respectively. Thanks to those projects and their contributors.

Code in the root of this repository is under the MIT License in [`LICENSE`](./LICENSE). The code and dependencies of the three component projects remain subject to the licenses of their own repositories; keep the corresponding copyright and license notices when copying, modifying, or redistributing.

# Desktop release updates

`pi-agent-desktop` 会将已安装的 macOS、Windows 或 Linux 应用作为一个由 updater 签名的完整包更新。该安装包会记录三个组件在 `src-tauri/resources/component-versions.json` 中的确切版本：

1. `stormwine1986/pi-agent-desktop`
2. `earendil-works/pi`
3. `agegr/pi-web`

The settings screen used to check the latest stable `stormwine1986/pi-agent-desktop` GitHub Release, at most once a week, and offer a single **Upgrade** button that downloaded that signed release, installed the complete app and restarted it. `fe47efa` removed that button, the background check and the `UpdateReminder` popup: this build is distributed by hand, so the check only ever answered "you're on the latest version". Settings › General now shows the current version and nothing else.

The updater machinery is still in the tree and dormant — the Tauri updater plugin, `lib/desktop-updater.ts` (`installLatestDesktopRelease`) and `app/api/updates/` (version metadata and the release mirror). Nothing in the app calls them. Re-wiring a button means restoring the mid-install guard too: `SettingsPanel` must not close on Escape or a backdrop click while an install runs (see `docs/agents/fork-ui.md`). Local builds deliberately do not register the updater plugin, so they cannot accept an update payload either way.

## Automatic component sync

`.github/workflows/component-updates.yml` runs every day and can also be started manually. It applies updates in dependency order:

1. update all `@earendil-works/pi-*` packages to the released `pi` version;
2. merge the released `pi-web` tag;
3. bump `pi-agent-desktop`, regenerate the component manifest, and run tests, typecheck, and lint;
4. commit and push the verified result directly to `main`;
5. explicitly dispatch the signed desktop release workflow.

The repository intentionally keeps only `main`; the automation does not create a component-update branch or pull request. Pushes use no force option. If an upstream merge conflicts or any validation fails, the workflow stops before updating `main` or publishing a Release, and the failed Actions run must be resolved manually.

## One-time signing setup

Tauri updater signatures are mandatory. Generate the updater signing key once on a trusted machine:

```bash
npm exec tauri signer generate -- -w ~/.tauri/pi-agent-desktop.key
```

Store these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password chosen during generation;
- `TAURI_UPDATER_PUBLIC_KEY`: the exact Base64 contents of the `.pub` file generated next to the private key.

The release workflow validates this public key before installing dependencies and
injects it into Tauri's updater configuration for both bundle signing and runtime
verification. The key is never printed by the workflow.

Never commit the private key or its password. The public key is embedded at compile time only in release builds. Local builds deliberately do not register the updater plugin.

## Publishing

After a successful component sync updates `main`, it explicitly starts **Publish signed desktop release**. The release workflow can also be started manually. It verifies that the bundled `pi` and `pi-web` versions exactly match their latest stable Releases, then sequentially creates Apple Silicon (`aarch64`) DMG/updater artifacts, a Linux x64 `.deb`, and a Windows x64 NSIS `-setup.exe`/updater archive. Intel Mac (`x86_64-apple-darwin`) artifacts are not built. The Release stays in draft until all platforms and the component manifest are present; only then is `v<pi-agent-desktop version>` published as the latest Release.

The workflow currently uses ad-hoc macOS application signing, Tauri updater signatures, and the native Linux package format. Before distributing outside a controlled environment, configure an Apple Developer ID certificate/notarization and a Windows Authenticode certificate. Without Authenticode, Windows may show a SmartScreen warning even though updater verification remains cryptographically signed.

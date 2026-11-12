#!/usr/bin/env node
/**
 * What an installed Entity Assistant says about itself, checked against itself
 * (SSR-000095 AC-8, and the AC-10 diagnostics entry).
 *
 * The package carries two files that describe the same build from different
 * sides — `resources/component-versions.json` (which commit, which branch,
 * which Next BUILD_ID) and `resources/server/node-runtime.json` (which Node the
 * payload was built with, and the hash of the runtime binary) — plus the two
 * binaries themselves. Nothing here writes: an install directory is read, at
 * most, and the log replay below only appends nothing and opens no new file.
 *
 * Exit codes: 0 every check agrees, 1 at least one does not (and the item is
 * named), 2 the arguments or the directory cannot be used at all.
 *
 * Usage:
 *   node scripts/verify-install.mjs --dir "%LOCALAPPDATA%\Entity Assistant"
 *   node scripts/verify-install.mjs --dir <dir> --json
 *   node scripts/verify-install.mjs --dir <dir> --log <desktop.log>
 *
 * `--dir` accepts either the install root (`…\Entity Assistant`) or its
 * `resources` directory. `--no-processes` skips the running-binary section on
 * a machine where process enumeration is slow or not wanted.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_NAME = "component-versions.json";
const BUILD_ID_PATH = [".next-desktop", "BUILD_ID"];
const SHELL_EXE = "pi-agent-desktop.exe";
const LOG_REPLAY_LIMIT = 20;

const ok = (id, detail) => ({ id, ok: true, detail });
const fail = (id, detail) => ({ id, ok: false, detail });
const skipped = (id, detail) => ({ id, ok: true, skipped: true, detail });

/** The two layouts a caller may point at, without guessing twice. */
export function locateLayout(target) {
  const dir = resolve(target);
  if (existsSync(join(dir, MANIFEST_NAME))) {
    return { installDir: resolve(dir, ".."), resources: dir };
  }
  if (existsSync(join(dir, "resources", MANIFEST_NAME))) {
    return { installDir: dir, resources: join(dir, "resources") };
  }
  return null;
}

export async function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** The shell executable's VERSIONINFO, which is a second witness of appVersion. */
function readShellProductVersion(exePath) {
  if (process.platform !== "win32") return { available: false, reason: "not Windows" };
  const script =
    `$v = (Get-Item -LiteralPath '${exePath.replaceAll("'", "''")}').VersionInfo.ProductVersion; ` +
    "if ($v) { Write-Output $v }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  const value = (result.stdout ?? "").trim();
  if (result.status !== 0 || !value) {
    return { available: false, reason: `VERSIONINFO unreadable (${(result.stderr ?? "").trim() || result.status})` };
  }
  return { available: true, value };
}

/**
 * Processes started from this install. The AC is "the hash of the running
 * binary, when it can be had": the executable of a running process cannot be
 * replaced while it runs, so matching it against the file the manifest
 * describes is the strongest statement available without a signature.
 */
function readRunningProcesses(installDir) {
  if (process.platform !== "win32") {
    return { available: false, reason: "process enumeration is Windows-only here", processes: [] };
  }
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='pi-agent-desktop.exe'\" | " +
    "Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    return { available: false, reason: `process enumeration failed (${result.status})`, processes: [] };
  }
  const raw = (result.stdout ?? "").trim();
  if (!raw) return { available: true, processes: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, reason: "process enumeration returned unparsable output", processes: [] };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const root = installDir.toLowerCase();
  return {
    available: true,
    processes: entries
      .filter((entry) => typeof entry?.ExecutablePath === "string" && entry.ExecutablePath)
      .filter((entry) => entry.ExecutablePath.toLowerCase().startsWith(root))
      .map((entry) => ({ pid: entry.ProcessId, path: entry.ExecutablePath })),
  };
}

const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isFullSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const isShortSha = (value) => typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value);

export async function verifyInstall(options = {}) {
  const layout = locateLayout(options.dir ?? process.cwd());
  if (!layout) {
    throw new Error(
      `no ${MANIFEST_NAME} under ${resolve(options.dir ?? process.cwd())} (neither at <dir> nor at <dir>/resources)`,
    );
  }
  const { installDir, resources } = layout;
  const checks = [];
  const diagnostics = { installDir, resources, paths: {}, values: {} };

  const manifestPath = join(resources, MANIFEST_NAME);
  const runtimePath = join(resources, "server", "node-runtime.json");
  const runtimeBinary = join(resources, "node", process.platform === "win32" ? "node.exe" : "node");
  const buildIdPath = join(resources, "server", ...BUILD_ID_PATH);
  const shellExe = join(installDir, SHELL_EXE);
  Object.assign(diagnostics.paths, {
    manifest: manifestPath,
    nodeRuntimeStamp: runtimePath,
    nodeRuntimeBinary: runtimeBinary,
    buildId: buildIdPath,
    shellExecutable: shellExe,
  });

  let manifest;
  try {
    manifest = await readJson(manifestPath);
    checks.push(ok("manifest", `${manifest?.appVersion ?? "(no appVersion)"} at ${manifestPath}`));
  } catch (error) {
    checks.push(fail("manifest", `cannot read ${manifestPath}: ${error.message}`));
    return { ok: false, checks, diagnostics };
  }

  const build = manifest?.build ?? null;
  diagnostics.values.manifest = {
    appVersion: manifest?.appVersion ?? null,
    components: Array.isArray(manifest?.components) ? manifest.components : [],
    build,
  };

  // A build fingerprint is only worth reading if it is well formed, and the
  // short sha is the cheap internal witness: a manifest whose gitCommit was
  // edited without editing everything else stops agreeing with itself.
  if (!isFullSha(build?.gitCommit)) {
    checks.push(fail("gitCommit", `build.gitCommit is not a 40-character commit sha: ${build?.gitCommit ?? "(missing)"}`));
  } else if (!isShortSha(build?.gitCommitShort) || !build.gitCommit.startsWith(build.gitCommitShort)) {
    checks.push(
      fail(
        "gitCommit",
        `build.gitCommit is ${build.gitCommit} but build.gitCommitShort is ${build?.gitCommitShort ?? "(missing)"}`,
      ),
    );
  } else {
    checks.push(ok("gitCommit", `${build.gitCommit} (${build.gitBranch}${build.gitDirty ? "+dirty" : ""})`));
  }

  // Does the server payload on disk run the build the manifest names? An
  // overwrite install that skipped a file leaves these two disagreeing.
  let diskBuildId = null;
  try {
    diskBuildId = (await readFile(buildIdPath, "utf8")).trim();
  } catch {
    diskBuildId = null;
  }
  if (!diskBuildId) {
    checks.push(fail("buildId", `no BUILD_ID at ${buildIdPath} to compare with build.buildId`));
  } else if (!build?.buildId) {
    checks.push(fail("buildId", `build.buildId is not recorded, the payload is ${diskBuildId}`));
  } else if (build.buildId !== diskBuildId) {
    checks.push(fail("buildId", `build.buildId is ${build.buildId} but the payload BUILD_ID is ${diskBuildId}`));
  } else {
    checks.push(ok("buildId", `${diskBuildId} (manifest and payload agree)`));
  }

  // The runtime stamp and the runtime binary: version from two sources, then
  // identity from the hash the packaging step recorded.
  let runtimeStamp = null;
  try {
    runtimeStamp = await readJson(runtimePath);
  } catch (error) {
    checks.push(fail("node-version", `cannot read ${runtimePath}: ${error.message}`));
  }
  if (runtimeStamp) {
    diagnostics.values.nodeRuntime = runtimeStamp;
    if (!build?.node) {
      checks.push(fail("node-version", "build.node is not recorded in the manifest"));
    } else if (runtimeStamp.node !== build.node) {
      checks.push(
        fail("node-version", `build.node is ${build.node} but node-runtime.json says ${runtimeStamp.node ?? "(missing)"}`),
      );
    } else if (!existsSync(runtimeBinary)) {
      checks.push(fail("node-version", `node-runtime.json declares ${runtimeStamp.node} but ${runtimeBinary} is missing`));
    } else {
      checks.push(ok("node-version", `${runtimeStamp.node} (manifest, runtime stamp and runtime binary present)`));
    }
  }

  const recordedHash = runtimeStamp?.sha256;
  let actualHash = null;
  if (existsSync(runtimeBinary)) {
    actualHash = await sha256File(runtimeBinary);
    diagnostics.values.nodeRuntimeSha256 = actualHash;
  }
  if (!isSha256(recordedHash)) {
    checks.push(
      fail(
        "node-sha256",
        `no sha256 recorded in ${runtimePath} — the package predates the runtime fingerprint, so the binary cannot be verified`,
      ),
    );
  } else if (!actualHash) {
    checks.push(fail("node-sha256", `${runtimeBinary} is missing, recorded ${recordedHash}`));
  } else if (actualHash !== recordedHash) {
    checks.push(fail("node-sha256", `recorded ${recordedHash} but ${runtimeBinary} hashes to ${actualHash}`));
  } else {
    checks.push(ok("node-sha256", `${actualHash} (${runtimeBinary})`));
  }

  // appVersion against the shell executable's own version resource. Optional:
  // the resources directory alone (a staging tree) has no shell binary.
  if (!existsSync(shellExe)) {
    checks.push(skipped("appVersion", `no ${SHELL_EXE} in ${installDir} — nothing to compare appVersion against`));
  } else {
    const version = readShellProductVersion(shellExe);
    if (!version.available) {
      checks.push(skipped("appVersion", `manifest ${manifest?.appVersion ?? "(missing)"}, shell ${version.reason}`));
    } else if (!manifest?.appVersion) {
      checks.push(fail("appVersion", `the shell reports ${version.value} but the manifest records no appVersion`));
    } else if (version.value !== manifest.appVersion) {
      checks.push(fail("appVersion", `manifest ${manifest.appVersion} but ${SHELL_EXE} reports ${version.value}`));
    } else {
      checks.push(ok("appVersion", `${version.value} (manifest and ${SHELL_EXE} agree)`));
    }
  }

  // Running binaries, when they can be had. A running executable cannot be
  // replaced under itself, so a match here means the process the user is
  // looking at runs the file that was just verified.
  if (options.processes === false) {
    checks.push(skipped("running-binary", "process enumeration skipped (--no-processes)"));
  } else {
    const running = readRunningProcesses(installDir);
    diagnostics.running = running;
    if (!running.available) {
      checks.push(skipped("running-binary", running.reason));
    } else if (running.processes.length === 0) {
      checks.push(ok("running-binary", "no process from this install is running"));
    } else {
      const described = [];
      for (const process of running.processes) {
        const hash = await sha256File(process.path);
        const name = process.path.slice(installDir.length).replace(/^[\\/]/, "");
        described.push(`pid ${process.pid} ${name} sha256 ${hash}`);
        if (resolve(process.path) === resolve(runtimeBinary) && isSha256(recordedHash) && hash !== recordedHash) {
          checks.push(fail("running-binary", `pid ${process.pid} runs ${process.path} with sha256 ${hash}, recorded ${recordedHash}`));
          break;
        }
      }
      checks.push(ok("running-binary", described.join("; ")));
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    diagnostics,
    logPath: options.logPath ?? defaultLogPath(),
  };
}

/** Where the shell writes its log; read-only, and only when it exists. */
export function defaultLogPath() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "com.abcwyc.pi-agent", "logs", "desktop.log");
    return null;
  }
  if (process.platform === "darwin") {
    const home = process.env.HOME;
    return home ? join(home, "Library", "Logs", "com.abcwyc.pi-agent", "desktop.log") : null;
  }
  const home = process.env.HOME;
  return home ? join(home, ".local", "share", "com.abcwyc.pi-agent", "logs", "desktop.log") : null;
}

/**
 * The clean-up records the installer and the shell leave behind (AC-10), so a
 * support report can be read back from the entry that verifies the install.
 * Only lines this product writes as records are replayed.
 */
export async function readCleanupRecords(logPath) {
  if (!logPath || !existsSync(logPath)) return { path: logPath, lines: [], note: "no desktop.log at that path" };
  const text = await readFile(logPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.includes("installer: action=") || line.includes("cleanup: strategy="))
    .slice(-LOG_REPLAY_LIMIT);
  return { path: logPath, lines };
}

function formatReport(result, records) {
  const width = Math.max(...result.checks.map((check) => check.id.length));
  const lines = [];
  lines.push(`Entity Assistant install verification`);
  lines.push(`  install dir  ${result.diagnostics.installDir}`);
  lines.push(`  resources    ${result.diagnostics.resources}`);
  lines.push("");
  for (const check of result.checks) {
    const state = check.skipped ? "n/a " : check.ok ? "ok  " : "FAIL";
    lines.push(`  ${check.id.padEnd(width)}  ${state}  ${check.detail}`);
  }
  lines.push("");
  lines.push("Diagnostics");
  const values = result.diagnostics.values ?? {};
  lines.push(`  manifest      ${JSON.stringify(values.manifest)}`);
  lines.push(`  node runtime  ${JSON.stringify(values.nodeRuntime ?? null)}`);
  if (values.nodeRuntimeSha256) lines.push(`  node.exe      sha256 ${values.nodeRuntimeSha256}`);
  if (result.diagnostics.running) {
    const running = result.diagnostics.running;
    lines.push(
      running.available
        ? `  running       ${running.processes.length === 0 ? "nothing from this install" : running.processes.map((entry) => `${entry.pid} ${entry.path}`).join(", ")}`
        : `  running       unavailable (${running.reason})`,
    );
  }
  lines.push(`  clean-up log  ${records.path ?? "(none found)"}`);
  if (records.lines.length === 0) {
    lines.push(`                ${records.note ?? "no install/clean-up record yet"}`);
  } else {
    for (const line of records.lines) lines.push(`                ${line}`);
  }
  lines.push("");
  lines.push(result.ok ? "OK — every value agrees" : "FAILED — see the item(s) marked FAIL");
  return `${lines.join("\n")}\n`;
}

async function main(argv) {
  const args = argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: node scripts/verify-install.mjs --dir <install dir> [--log <desktop.log>] [--json] [--no-processes]\n",
    );
    return 0;
  }
  const dir = value("--dir");
  if (!dir) {
    process.stderr.write("verify-install: --dir <install directory> is required\n");
    return 2;
  }

  let result;
  try {
    result = await verifyInstall({
      dir,
      logPath: value("--log") ?? undefined,
      processes: !args.includes("--no-processes"),
    });
  } catch (error) {
    process.stderr.write(`verify-install: ${error.message}\n`);
    return 2;
  }

  const records = await readCleanupRecords(result.logPath);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...result, records }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(result, records));
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv);
}

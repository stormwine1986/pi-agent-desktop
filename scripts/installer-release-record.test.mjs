import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const hooksPath = join(rootDir, "src-tauri", "installer-hooks.nsh");
const probePath = join(rootDir, "scripts", "installer-release-probe.nsi");
const hooks = await readFile(hooksPath, "utf8");

// SSR-000095 AC-10: an overwrite install that went wrong has to be explainable
// afterwards — which file was held, what the Restart Manager said, which PIDs
// held it, which strategy the hook took and which failure code came out. These
// assertions read the shipped hook; the compiled probe below runs it.
function macroBody(name) {
  const start = hooks.indexOf(`!macro ${name}`);
  assert.notEqual(start, -1, `!macro ${name} is gone from installer-hooks.nsh`);
  const end = hooks.indexOf("!macroend", start);
  assert.notEqual(end, -1, `unterminated !macro ${name}`);
  return hooks.slice(start, end);
}

const record = macroBody("EA_RecordCleanup");
const release = macroBody("EA_ReleaseBundledRuntime");

test("one clean-up record carries the path, the RM status, the PIDs, the strategy and the code", () => {
  for (const field of [
    "path=${path}",
    "restart-manager=${status}",
    "pids=${holders}",
    "strategy=${strategy}",
    "code=${code}",
  ]) {
    assert.ok(record.includes(field), `the record line lost ${field}`);
  }
  assert.match(record, /DetailPrint "Entity Assistant: \$\{action\}/, "the details pane carries the record too");
  assert.match(record, /FileWrite \$R8 "installer: action=\$\{action\}/, "and it goes to desktop.log");
});

test("the record is additive: no log directory is created and $INSTDIR stays untouched", () => {
  assert.match(record, /\$\{FileExists\} "\$\{EA_LOG_FILE\}"/, "only an existing log file is appended to");
  assert.doesNotMatch(record, /CreateDirectory/, "the installer must not create the log directory");
  assert.doesNotMatch(record, /"\$INSTDIR\\/, "the record must not write inside the install directory");
});

test("holders are enumerated before the shutdown that removes them", () => {
  const holdersAt = release.indexOf("EA_ListHolders");
  const shutdownAt = release.indexOf("RestartManager_ShutdownFile");
  assert.notEqual(holdersAt, -1, "the release path no longer enumerates the holders");
  assert.notEqual(shutdownAt, -1, "the release path no longer shuts the runtime down");
  assert.ok(holdersAt < shutdownAt, "RmGetList has to run before RmShutdown ends the processes");
  assert.match(
    macroBody("EA_ListHolders"),
    /RmGetList/,
    "the holders come from the Restart Manager, not from a guess",
  );
});

test("an install that had to refuse names the strategy and a deterministic exit code", () => {
  assert.match(release, /SetErrorLevel \$\{EA_EXIT_RUNTIME_LOCKED\}/, "the abort path sets an exit code");
  assert.match(release, /"abort-locked"/, "the abort path says which strategy it took");
  assert.match(release, /"shutdown-and-overwrite"/, "the success path says which strategy it took");
  assert.match(release, /"no-bundled-runtime"/, "an install with no runtime says so instead of staying silent");
  assert.match(hooks, /!define \/ifndef EA_EXIT_RUNTIME_LOCKED 1603/, "1603 (ERROR_INSTALL_FAILURE) is the documented code");
});

// ---------------------------------------------------------------------------
// The compiled probe: expand the shipped hook into a throwaway installer and
// run it against a fixture file. No product install, no user directory.
// ---------------------------------------------------------------------------

function findMakensis() {
  const candidates = [
    process.env.EA_MAKENSIS,
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "Bin", "makensis.exe")
      : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\NSIS\\makensis.exe" : "",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  try {
    const which = execFileSync(process.platform === "win32" ? "where" : "which", ["makensis"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    return which.split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

const makensis = process.platform === "win32" ? findMakensis() : null;
const makensisSkip = makensis ? false : "needs Windows and makensis (Tauri's NSIS) to compile the probe";

function compileProbe(dir, defines) {
  // `OutFile` resolves against the .nsi's own directory, so the output path is
  // passed as a define rather than with `/O`.
  const args = ["/V1"];
  const all = { ...defines, EA_PROBE_OUTFILE: join(dir, "probe.exe") };
  for (const [name, value] of Object.entries(all)) args.push(`/D${name}=${value}`);
  args.push(probePath);
  const result = spawnSync(makensis, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "/" },
  });
  assert.equal(result.status, 0, `makensis failed:\n${result.stdout}\n${result.stderr}`);
}

/** A process that keeps the fixture runtime open, so the Restart Manager has
 *  something real to report and to end. */
async function holdFile(target) {
  const child = spawn(
    process.execPath,
    ["-e", "require('fs').openSync(process.argv[1], 'r+'); setInterval(() => {}, 1000);", target],
    { stdio: "ignore", windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    setTimeout(resolve, 500);
  });
  return child;
}

test("a real run records the held file, the holder PID, the strategy and the code", { skip: makensisSkip }, async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-release-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const runtimeDir = join(dir, "install", "resources", "node");
  await mkdir(runtimeDir, { recursive: true });
  const runtime = join(runtimeDir, "node.exe");
  await writeFile(runtime, "fixture runtime\n");
  const logPath = join(dir, "desktop.log");
  await writeFile(logPath, "startup v0.0.0 pid 1 (windows)\r\n");

  const holder = await holdFile(runtime);
  t.after(() => holder.kill());

  compileProbe(dir, {
    EA_PROBE_TARGET: runtime,
    EA_PROBE_LOG: logPath,
  });
  const run = spawnSync(join(dir, "probe.exe"), [], { timeout: 60_000 });
  assert.equal(run.status, 0, `the probe must exit 0 after a successful release, got ${run.status}`);

  const log = await readFile(logPath, "utf8");
  const line = log.split(/\r?\n/).find((entry) => entry.includes("installer: action=install"));
  assert.ok(line, `no record was appended, log was:\n${log}`);
  assert.match(line, /path=.*resources\\node\\node\.exe/, "the record names the full runtime path");
  assert.match(line, /restart-manager=0/, "the record carries the Restart Manager status");
  assert.ok(
    line.includes(`pids=pid:${holder.pid}`),
    `the record must name the holder PID ${holder.pid}, got: ${line}`,
  );
  assert.match(line, /strategy=shutdown-and-overwrite/);
  assert.match(line, /code=0/);
  assert.match(log, /startup v0\.0\.0 pid 1 \(windows\)/, "the record is appended, never overwriting the shell's log");

  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(holder.exitCode === null && holder.signalCode === null, false, "the held runtime must be released");
});

test("a locked runtime records the abort, its strategy and exit code 1603", { skip: makensisSkip }, async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-release-probe-locked-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const runtimeDir = join(dir, "install", "resources", "node");
  await mkdir(runtimeDir, { recursive: true });
  const runtime = join(runtimeDir, "node.exe");
  await writeFile(runtime, "fixture runtime\n");
  const logPath = join(dir, "desktop.log");
  await writeFile(logPath, "startup v0.0.0 pid 1 (windows)\r\n");

  // Append hand-built: what an installation cannot write looks like on disk.
  // (WD,AD) only denies data writes and appends, so the fixture stays readable
  // and the deny ACE can be removed again.
  const user = process.env.USERNAME ?? "";
  const deny = spawnSync("icacls", [runtime, "/deny", `${user}:(WD,AD)`], { encoding: "utf8", windowsHide: true });
  if (deny.status !== 0) {
    t.skip(`icacls could not deny appends on the fixture: ${deny.stdout}${deny.stderr}`);
    return;
  }
  t.after(() => {
    spawnSync("icacls", [runtime, "/remove:d", user], { windowsHide: true });
  });

  compileProbe(dir, {
    EA_PROBE_TARGET: runtime,
    EA_PROBE_LOG: logPath,
  });
  const run = spawnSync(join(dir, "probe.exe"), [], { timeout: 60_000 });
  assert.equal(run.status, 1603, `a silent locked runtime must exit 1603, got ${run.status}`);

  const log = await readFile(logPath, "utf8");
  const line = log.split(/\r?\n/).find((entry) => entry.includes("installer: action=install"));
  assert.ok(line, `no record was appended, log was:\n${log}`);
  assert.match(line, /path=.*resources\\node\\node\.exe/);
  assert.match(line, /strategy=abort-locked/);
  assert.match(line, /code=1603/);
  assert.match(line, /restart-manager=0/, "nothing held the file: the Restart Manager reports 0");
  assert.match(line, /pids=none/, "and the holder list says so instead of inventing a PID");
});

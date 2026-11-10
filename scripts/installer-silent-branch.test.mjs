import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// SSR-000095 AC-3: a `/S` install has to heal itself, and an unattended install
// has nobody to click OK. `EA_ReleaseBundledRuntime` therefore has to follow
// Tauri's own CheckIfAppIsRunning (src-tauri/target/*/nsis/x64/utils.nsh) and
// keep the "still locked" path non-interactive when silent: log the exact file
// and abort, never a MessageBox.
const hooks = await readFile(join(rootDir, "src-tauri", "installer-hooks.nsh"), "utf8");

function lockedRuntimeBlock() {
  const start = hooks.indexOf('FileOpen $R9 "${EA_NODE_RUNTIME}" a');
  assert.notEqual(start, -1, "the FileOpen writability probe is gone from installer-hooks.nsh");
  const end = hooks.indexOf("!macroend", start);
  assert.notEqual(end, -1, "unterminated EA_ReleaseBundledRuntime macro");
  return hooks.slice(start, end);
}

// Labels inside the macro are `name:` lines; every `${__LINE__}`-derived label
// is unique per insertion site, so the sections are keyed by their suffix-free
// text when the exact label is known from the IfSilent line.
function branchOf(block, label) {
  const at = block.indexOf(`${label}:`);
  assert.notEqual(at, -1, `IfSilent targets ${label}, but the label is missing`);
  const rest = block.slice(at + label.length + 1);
  const next = rest.search(/^\s*\S+:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test("a silent install never reaches the MessageBox on the locked-runtime path", () => {
  const block = lockedRuntimeBlock();
  const guarded = block.match(/^\s*IfSilent\s+(\S+)\s+(\S+)\s*$/m);
  assert.ok(guarded, "the locked-runtime failure path must be guarded by IfSilent");
  const [, silentLabel, uiLabel] = guarded;

  const silent = branchOf(block, silentLabel);
  assert.match(silent, /Abort/, "the silent branch must abort instead of continuing the install");
  assert.match(
    silent,
    /DetailPrint "Entity Assistant: cannot open .*still locked after Restart Manager shutdown/,
    "the silent branch must log the locked path and the reason",
  );
  assert.doesNotMatch(silent, /^\s*MessageBox /m, "a `/S` install must not wait for a click");

  const interactive = branchOf(block, uiLabel);
  assert.match(interactive, /MessageBox MB_ICONSTOP\|MB_OK/, "the interactive branch still prompts");
  assert.match(interactive, /Abort/);

  // Exactly one dialog in the whole failure path: the interactive one.
  assert.equal(block.match(/^\s*MessageBox /gm).length, 1);
});

test("the interactive prompt keeps its actionable wording", () => {
  const block = lockedRuntimeBlock();
  assert.match(
    block,
    /MessageBox MB_ICONSTOP\|MB_OK "Entity Assistant is still running\. Close Entity Assistant completely \(including the tray icon\), then start the installer again\. If it keeps happening, end this process in Task Manager and retry: \$\{EA_NODE_RUNTIME\}"/,
  );
});

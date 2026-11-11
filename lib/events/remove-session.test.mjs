import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { removeSessionSubscriptions } = await jiti.import("./remove-session.ts");

const BODY = [
  "version: 1",
  "sessions:",
  '  - sessionId: "keep-me"',
  "    subscriptions:",
  '      - name: "a"',
  "        server: entity-base",
  "        workspace: ws_a",
  '  - sessionId: "delete-me"',
  "    subscriptions:",
  '      - name: "b"',
  "        server: entity-base",
  "        workspace: ws_a",
  "",
].join("\n");

function withProject(body, run) {
  const dir = mkdtempSync(join(tmpdir(), "events-remove-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "events.yaml"), body, "utf8");
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deleting a session removes its entry from the file", () => {
  withProject(BODY, (dir) => {
    const changed = removeSessionSubscriptions(dir, ["delete-me"]);
    assert.equal(changed, true);
    const text = readFileSync(join(dir, ".pi", "events.yaml"), "utf8");
    assert.match(text, /keep-me/);
    assert.doesNotMatch(text, /delete-me/);
  });
});

test("an id the file does not mention is left alone", () => {
  withProject(BODY, (dir) => {
    const before = readFileSync(join(dir, ".pi", "events.yaml"), "utf8");
    const changed = removeSessionSubscriptions(dir, ["never-existed"]);
    assert.equal(changed, false);
    assert.equal(readFileSync(join(dir, ".pi", "events.yaml"), "utf8"), before);
  });
});

test("a project without the file is not touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "events-remove-"));
  try {
    assert.equal(removeSessionSubscriptions(dir, ["x"]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

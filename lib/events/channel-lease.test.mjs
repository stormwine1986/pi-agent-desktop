import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { claimChannel, releaseChannel } = await jiti.import("./channel-lease.ts");

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "events-lease-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeClaim(dir, key, claim) {
  // The claim file name mirrors channel-lease's own sanitising.
  writeFileSync(join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.owner.json`), JSON.stringify(claim));
}

test("an unclaimed channel belongs to the first process", () => {
  withDir((dir) => {
    const verdict = claimChannel(dir, "a|b", { alive: () => true, startedAt: "2026-11-11T02:00:00.000Z", now: Date.parse("2026-11-11T02:00:00.000Z") });
    assert.equal(verdict.owner, true);
  });
});

test("a newer live instance takes the channel over (later wins)", () => {
  withDir((dir) => {
    writeClaim(dir, "a|b", { pid: process.pid + 1, startedAt: "2026-11-11T03:00:00.000Z" });
    const verdict = claimChannel(dir, "a|b", { alive: () => true, startedAt: "2026-11-11T01:00:00.000Z" });
    assert.equal(verdict.owner, false);
    assert.match(verdict.reason, /另一实例接管/);
  });
});

test("an older live instance does not fight back", () => {
  withDir((dir) => {
    writeClaim(dir, "a|b", { pid: process.pid + 1, startedAt: "2026-11-11T01:00:00.000Z" });
    const verdict = claimChannel(dir, "a|b", { alive: () => true, startedAt: "2026-11-11T03:00:00.000Z" });
    assert.equal(verdict.owner, true);
    const written = JSON.parse(readFileSync(join(dir, "a_b.owner.json"), "utf8"));
    assert.equal(written.startedAt, "2026-11-11T03:00:00.000Z");
  });
});

test("a dead owner's claim is taken over, so a crash does not lock the channel", () => {
  withDir((dir) => {
    writeClaim(dir, "a|b", { pid: process.pid + 1, startedAt: "2026-11-11T05:00:00.000Z" });
    const verdict = claimChannel(dir, "a|b", { alive: () => false, startedAt: "2026-11-11T01:00:00.000Z" });
    assert.equal(verdict.owner, true);
  });
});

test("release only removes this process's own claim", () => {
  withDir((dir) => {
    writeClaim(dir, "a|b", { pid: process.pid + 1, startedAt: "2026-11-11T05:00:00.000Z" });
    releaseChannel(dir, "a|b");
    assert.ok(readFileSync(join(dir, "a_b.owner.json"), "utf8").includes("05:00"));
  });
});

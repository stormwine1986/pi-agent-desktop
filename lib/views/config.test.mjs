import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { readViewsConfig } = await jiti.import("./config.ts");

/** A workspace whose `.pi/views.yaml` holds `body`; removed when the test ends. */
function withViews(body, run) {
  const dir = mkdtempSync(join(tmpdir(), "views-config-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "views.yaml"), body, "utf8");
    return run(readViewsConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID = [
  "title: 我的审批",
  "server: entity-base",
  "workspace: ws_entity_base",
  "dql: \"type = 'OR'\"",
  "columns: [key, name]",
].join("\n");

test("notify defaults to true", () => {
  withViews(`views:\n  - ${VALID.replace(/\n/g, "\n    ")}\n`, (config) => {
    assert.equal(config.error, null);
    assert.equal(config.views.length, 1);
    assert.equal(config.views[0].error, null);
    assert.equal(config.views[0].view.notify, true);
  });
});

test("notify: false is kept", () => {
  withViews(`views:\n  - ${VALID.replace(/\n/g, "\n    ")}\n    notify: false\n`, (config) => {
    assert.equal(config.views[0].view.notify, false);
  });
});

test("a non-boolean notify fails the view and says why", () => {
  withViews(`views:\n  - ${VALID.replace(/\n/g, "\n    ")}\n    notify: sometimes\n`, (config) => {
    const entry = config.views[0];
    assert.equal(entry.view, null);
    assert.match(entry.error, /notify 只能是 true 或 false/);
  });
});

test("one bad notify does not take the other views down", () => {
  const second = VALID.replace("我的审批", "未挂链的 TC");
  withViews(
    `views:\n  - ${VALID.replace(/\n/g, "\n    ")}\n    notify: 0\n  - ${second.replace(/\n/g, "\n    ")}\n`,
    (config) => {
      assert.equal(config.views[0].view, null);
      assert.equal(config.views[1].error, null);
      assert.equal(config.views[1].view.notify, true);
    },
  );
});

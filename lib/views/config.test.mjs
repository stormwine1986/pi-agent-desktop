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

test("a view keeps the group it names", () => {
  withViews(
    [
      "views:",
      "  - title: 未关闭缺陷",
      "    group: 税号子系统",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'Defect'\"",
      "    columns: [key]",
    ].join("\n"),
    (config) => {
      assert.equal(config.views[0].view.group, "税号子系统");
    },
  );
});

test("a view without a group is ungrouped, and an empty one means the same", () => {
  withViews(
    [
      "views:",
      "  - title: 我负责的 MR",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'MR'\"",
      "    columns: [key]",
      "  - title: 我负责的 OR",
      "    group: \"   \"",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'OR'\"",
      "    columns: [key]",
    ].join("\n"),
    (config) => {
      // Blank is what a customer leaves behind after ungrouping a view: it must
      // not turn into a group named "   ".
      assert.equal(config.views[0].view.group, null);
      assert.equal(config.views[1].view.group, null);
    },
  );
});

test("a non-string group fails that view and says which field", () => {
  withViews(
    [
      "views:",
      "  - title: 坏视图",
      "    group: 3",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'OR'\"",
      "    columns: [key]",
      "  - title: 好视图",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'MR'\"",
      "    columns: [key]",
    ].join("\n"),
    (config) => {
      assert.match(config.views[0].error, /group/);
      assert.equal(config.views[0].view, null);
      assert.equal(config.views[1].error, null);
    },
  );
});

test("groups declare order and folding, and keep the order they were written in", () => {
  withViews(
    [
      "groups:",
      "  - 税号子系统",
      "  - title: 开票子系统",
      "    collapsed: true",
      "views:",
      "  - title: 一",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'OR'\"",
      "    columns: [key]",
    ].join("\n"),
    (config) => {
      assert.deepEqual(config.groups, [
        { title: "税号子系统", collapsed: false },
        { title: "开票子系统", collapsed: true },
      ]);
    },
  );
});

test("a malformed groups list is a file-level error, not a broken view", () => {
  withViews(
    [
      "groups: 税号子系统",
      "views:",
      "  - title: 一",
    ].join("\n"),
    (config) => {
      assert.match(config.error, /groups 必须是数组/);
      assert.deepEqual(config.views, []);
    },
  );
});

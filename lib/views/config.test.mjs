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

const WATCH_VIEW = [
  "views:",
  "  - title: 待执行任务",
  "    server: entity-base",
  "    workspace: ws_manhu",
  "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
  "    columns: [key]",
  "    watch:",
  "      project: ../work",
  "      prompt: .pi/prompts/task.md",
  "      claim:",
  "        from: DEFINED",
  "        to: IN_PROGRESS",
  "        manual: BLOCKED",
].join("\n");

test("a watch block is parsed into three states and two numbers", () => {
  withViews(WATCH_VIEW, (config) => {
    const watch = config.views[0].view.watch;
    assert.equal(watch.enabled, true);
    assert.deepEqual(watch.claim, { from: "DEFINED", to: "IN_PROGRESS", manual: "BLOCKED" });
    assert.equal(watch.intervalSec, 90);
    assert.equal(watch.timeoutMin, 120);
    // Paths are resolved against the project that owns views.yaml, so the pump
    // never has to guess a working directory.
    assert.ok(watch.project.endsWith("work"));
    assert.ok(watch.prompt.includes(".pi"));
  });
});

test("a view without a watch block stays read-only", () => {
  withViews(["views:", "  - " + VALID.split("\n")[0], ...VALID.split("\n").slice(1).map((line) => "    " + line)].join("\n"), (config) => {
    assert.equal(config.views[0].error, null);
    assert.equal(config.views[0].view.watch, null);
  });
});

test("claim states must be strings: a number fails that view only", () => {
  const body = [
    "views:",
    "  - title: 坏视图",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
    "    columns: [key]",
    "    watch:",
    "      project: ../work",
    "      prompt: .pi/prompts/task.md",
    "      claim:",
    "        from: DEFINED",
    "        to: 3",
    "        manual: BLOCKED",
    "  - title: 好视图",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
    "    columns: [key]",
  ].join("\n");

  withViews(body, (config) => {
    assert.match(config.views[0].error, /claim\.to/);
    assert.equal(config.views[0].view, null);
    assert.equal(config.views[1].error, null);
  });
});

test("a missing requirement in watch is named in the error", () => {
  const body = [
    "views:",
    "  - title: 缺东西",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
    "    columns: [key]",
    "    watch:",
    "      enabled: true",
    "      claim:",
    "        from: DEFINED",
  ].join("\n");

  withViews(body, (config) => {
    assert.match(config.views[0].error, /watch\.project/);
    assert.match(config.views[0].error, /watch\.prompt/);
    assert.match(config.views[0].error, /claim\.to/);
    assert.match(config.views[0].error, /claim\.manual/);
  });
});

test("intervalSec rejects what is not a positive number", () => {
  const body = [
    "views:",
    "  - title: 参数怪",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
    "    columns: [key]",
    "    watch:",
    "      project: ../work",
    "      prompt: .pi/prompts/task.md",
    "      intervalSec: \"90s\"",
    "      claim:",
    "        from: DEFINED",
    "        to: IN_PROGRESS",
    "        manual: BLOCKED",
  ].join("\n");

  withViews(body, (config) => {
    assert.match(config.views[0].error, /watch\.intervalSec/);
  });
});

test("the removed retry settings are called out instead of silently ignored", () => {
  // Someone upgrading a views.yaml still carries maxFailures and claim.back. A
  // silent drop would leave them believing failures get retried.
  const body = [
    "views:",
    "  - title: 老配置",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
    "    columns: [key]",
    "    watch:",
    "      project: ../work",
    "      prompt: .pi/prompts/task.md",
    "      maxFailures: 3",
    "      claim:",
    "        from: DEFINED",
    "        to: IN_PROGRESS",
    "        back: DEFINED",
    "        manual: BLOCKED",
  ].join("\n");

  withViews(body, (config) => {
    assert.match(config.views[0].error, /maxFailures 已移除/);
    assert.match(config.views[0].error, /claim\.back 已移除/);
    assert.equal(config.views[0].view, null);
  });
});

// ---------------------------------------------------------------------------
// `orderBy` / `order` as lists (SSR-000066 rev20, SSR-000055 multi-key).
//
// A list is a configuration the panel hands to `list` verbatim, so parsing must
// keep it exactly as written — and refuse what cannot be one query: an empty
// element, mismatched lengths, an invalid direction.
// ---------------------------------------------------------------------------

const sorted = (extra) =>
  [
    "views:",
    "  - title: 多键视图",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK'\"",
    "    columns: [key]",
    ...extra,
  ].join("\n");

test("a single orderBy keeps its string form and the default direction", () => {
  withViews(sorted(["    orderBy: modified_at"]), (config) => {
    assert.equal(config.views[0].error, null);
    assert.equal(config.views[0].view.orderBy, "modified_at");
    // Unchanged: a key without a direction still means `desc` for the table.
    assert.equal(config.views[0].view.order, "desc");
  });
});

test("an orderBy list is kept in order, with one direction per key", () => {
  withViews(
    sorted([
      "    orderBy:",
      "      - priority",
      "      - modified_at",
      "    order:",
      "      - desc",
      "      - asc",
    ]),
    (config) => {
      assert.equal(config.views[0].error, null);
      assert.deepEqual(config.views[0].view.orderBy, ["priority", "modified_at"]);
      assert.deepEqual(config.views[0].view.order, ["desc", "asc"]);
    },
  );
});

test("a single direction next to a key list applies to all of them (unchanged)", () => {
  withViews(
    sorted(["    orderBy: [priority, modified_at]", "    order: asc"]),
    (config) => {
      assert.equal(config.views[0].error, null);
      assert.deepEqual(config.views[0].view.orderBy, ["priority", "modified_at"]);
      // Not expanded here: `list` accepts one value for every key, and inventing
      // an array would send something the author did not write.
      assert.equal(config.views[0].view.order, "asc");
    },
  );
});

test("an empty element in the key list is refused and points at its position", () => {
  withViews(sorted(['    orderBy: [priority, "  ", modified_at]']), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /orderBy 第 2 项是空字符串/);
  });
});

test("an empty key list is refused instead of quietly not sorting", () => {
  withViews(sorted(["    orderBy: []"]), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /orderBy 是空数组/);
  });
});

test("a non-string key in the list names the position", () => {
  withViews(sorted(["    orderBy: [priority, 3]"]), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /orderBy 第 2 项只能是字段名/);
  });
});

test("direction and key counts must match, and the message says both", () => {
  withViews(
    sorted(["    orderBy: [priority, modified_at]", "    order: [desc]"]),
    (config) => {
      assert.equal(config.views[0].view, null);
      assert.match(config.views[0].error, /order 有 1 个方向，orderBy 有 2 个键（长度不齐/);
    },
  );
});

test("an invalid direction inside the list names its position", () => {
  withViews(
    sorted(["    orderBy: [priority, modified_at]", "    order: [desc, up]"]),
    (config) => {
      assert.equal(config.views[0].view, null);
      assert.match(config.views[0].error, /order 第 2 项只能是 asc 或 desc（写的是 "up"）/);
    },
  );
});

test("a direction list without keys is refused rather than ignored", () => {
  withViews(sorted(["    order: [desc, asc]"]), (config) => {
    assert.equal(config.views[0].view, null);
    // TASK-000460: one sentence for both shapes — the mistake is the missing
    // `orderBy`, not the list.
    assert.match(config.views[0].error, /order 需要同时写 orderBy/);
  });
});

test("a single direction without keys is an error, not a silent no-op", () => {
  withViews(sorted(["    order: desc"]), (config) => {
    assert.equal(config.views[0].view, null, "the view must not render as unsorted");
    assert.match(config.views[0].error, /order 需要同时写 orderBy/);
    assert.match(config.views[0].error, /等于没排序/);
  });
});

test("a blank orderBy next to an explicit order is the same error", () => {
  withViews(sorted(["    orderBy: \"\"", "    order: asc"]), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /order 需要同时写 orderBy/);
  });
});

test("orderBy plus order keeps its behaviour, direction unchanged", () => {
  withViews(sorted(["    orderBy: modified_at", "    order: asc"]), (config) => {
    assert.equal(config.views[0].error, null);
    assert.equal(config.views[0].view.orderBy, "modified_at");
    assert.equal(config.views[0].view.order, "asc");
  });
});

test("one bad sort in a view fails only that view", () => {
  withViews(
    [
      "views:",
      "  - title: 坏排序",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'TASK'\"",
      "    columns: [key]",
      "    orderBy: [priority]",
      "    order: [desc, asc]",
      "  - title: 好排序",
      "    server: entity-base",
      "    workspace: ws_manhu",
      "    dql: \"type = 'MR'\"",
      "    columns: [key]",
      "    orderBy: [priority, modified_at]",
      "    order: [desc, asc]",
    ].join("\n"),
    (config) => {
      assert.equal(config.views[0].view, null);
      assert.match(config.views[0].error, /长度不齐/);
      assert.equal(config.views[1].error, null);
      assert.deepEqual(config.views[1].view.orderBy, ["priority", "modified_at"]);
    },
  );
});

// ---------------------------------------------------------------------------
// `watch.fill` (TASK-000461): field name → template, for the fields an automatic
// 转待人工 has to write. Only the shape is decided here; whether the configured
// fields are the required ones needs metadata, so that lives in `watch/index.ts`
// (`validate`).
// ---------------------------------------------------------------------------

/** A watch view with extra lines appended inside the `watch:` block. */
const watchWith = (lines) =>
  [
    "views:",
    "  - title: 待执行任务",
    "    server: entity-base",
    "    workspace: ws_manhu",
    "    dql: \"type = 'TASK' and state = 'DEFINED'\"",
    "    columns: [key]",
    "    watch:",
    "      project: ../work",
    "      prompt: .pi/prompts/task.md",
    "      intervalSec: 90",
    "      timeoutMin: 120",
    ...lines,
    "      claim:",
    "        from: DEFINED",
    "        to: IN_PROGRESS",
    "        manual: BLOCKED",
  ].join("\n");

test("a fill map is parsed as field → template, untouched", () => {
  withViews(
    watchWith([
      "      fill:",
      "        remarks: \"【自动】{{view}} · {{key}} 由派发泵写入：{{reason}}\"",
      "        solution: \"{{from}} → {{to}}（{{type}}）\"",
    ]),
    (config) => {
      assert.equal(config.views[0].error, null);
      assert.deepEqual(config.views[0].view.watch.fill, {
        remarks: "【自动】{{view}} · {{key}} 由派发泵写入：{{reason}}",
        solution: "{{from}} → {{to}}（{{type}}）",
      });
    },
  );
});

test("no fill block means nothing to fill — the same object an old file gives", () => {
  withViews(watchWith([]), (config) => {
    assert.equal(config.views[0].error, null);
    assert.deepEqual(config.views[0].view.watch.fill, {});
  });
});

test("fill must be a map, and the error shows the shape in words", () => {
  withViews(watchWith(["      fill: 写点什么"]), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /watch\.fill 必须是对象/);
  });
});

test("a non-string template is refused, naming the field", () => {
  withViews(watchWith(["      fill:", "        remarks: 3"]), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /watch\.fill\.remarks 只能是模板字符串/);
  });
});

test("an empty template is refused instead of writing a blank field", () => {
  withViews(watchWith(["      fill:", "        remarks: \"  \""]), (config) => {
    assert.equal(config.views[0].view, null);
    assert.match(config.views[0].error, /watch\.fill\.remarks 是空模板/);
  });
});

test("an unknown placeholder is named with the list of usable ones", () => {
  withViews(watchWith(["      fill:", "        remarks: \"{{kye}} 写错了\""]), (config) => {
    assert.equal(config.views[0].view, null);
    // A literal {{kye}} in an entity is exactly what nobody asked for.
    assert.match(config.views[0].error, /\{\{kye\}\} 不是可用占位符/);
    assert.match(config.views[0].error, /\{\{key\}\}/);
    assert.match(config.views[0].error, /\{\{reason\}\}/);
  });
});

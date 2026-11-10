import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { validate } = await jiti.import("./index.ts");

/** A board project plus an execution project, both real directories. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "watch-validate-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const prompt = join(root, "task.md");
  writeFileSync(prompt, "处理 {{key}}");
  return {
    root,
    watch: {
      enabled: true,
      project: work,
      prompt,
      intervalSec: 90,
      timeoutMin: 120,
      claim: { from: "DEFINED", to: "IN_PROGRESS", manual: "BLOCKED" },
    },
  };
}

function view(overrides = {}) {
  return {
    title: "待执行任务",
    server: "entity-base",
    workspace: "ws_manhu",
    dql: "type = 'TASK' and state = 'DEFINED'",
    columns: ["key"],
    orderBy: null,
    order: "desc",
    pageSize: 50,
    notify: true,
    group: null,
    watch: null,
    ...overrides,
  };
}

const TASK_STATES = ["DRAFT", "DEFINED", "IN_PROGRESS", "BLOCKED", "FINISHED", "INVALID"];

function deps(metadata) {
  return {
    now: () => 0,
    log: () => undefined,
    async metadata() {
      return metadata;
    },
  };
}

const okRoutes = [
  { from: "DEFINED", to: "IN_PROGRESS" },
  { from: "IN_PROGRESS", to: "DEFINED" },
  { from: "IN_PROGRESS", to: "BLOCKED" },
];

test("a fully connected view validates", async () => {
  const { root, watch } = fixture();
  const result = await validate(root, view(), watch, deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }));
  assert.equal(result, null);
});

test("a state the type does not have is refused, and the error names it", async () => {
  const { root, watch } = fixture();
  const broken = { ...watch, claim: { ...watch.claim, to: "DOING" } };
  const result = await validate(root, view(), broken, deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }));
  assert.match(result, /claim\.to/);
  assert.match(result, /DOING/);
});

test("a missing route to the manual state is refused even when both states exist", async () => {
  const { root, watch } = fixture();
  // Without an exit to manual the pump could only leave an item claimed forever,
  // so this view is not dispatchable — there is no retry path to fall back on.
  const noParking = [
    { from: "DEFINED", to: "IN_PROGRESS" },
    { from: "IN_PROGRESS", to: "DEFINED" },
  ];
  const result = await validate(root, view(), watch, deps({ ok: true, value: { validStates: TASK_STATES, routes: noParking } }));
  assert.match(result, /IN_PROGRESS → BLOCKED/);
});

test("an execution directory that is not there is refused", async () => {
  const { root, watch } = fixture();
  const result = await validate(
    root,
    view(),
    { ...watch, project: join(root, "nope") },
    deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }),
  );
  assert.match(result, /watch\.project/);
});

test("a DQL without a state predicate cannot be sliced and is refused up front", async () => {
  const { root, watch } = fixture();
  const result = await validate(
    root,
    view({ dql: "type = 'TASK'" }),
    watch,
    deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }),
  );
  assert.match(result, /state/);
});

test("manual equal to from would re-dispatch the parked item, so it is refused", async () => {
  const { root, watch } = fixture();
  const broken = { ...watch, claim: { ...watch.claim, manual: "DEFINED" } };
  const result = await validate(root, view(), broken, deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }));
  assert.match(result, /manual/);
});

test("metadata that cannot be read leaves the view disabled rather than guessing", async () => {
  const { root, watch } = fixture();
  const result = await validate(root, view(), watch, deps({ ok: false, error: "server down" }));
  assert.match(result, /server down/);
});

test("a state in (...) DQL is disabled at configuration time, with the view name", async () => {
  const { root, watch } = fixture();
  const result = await validate(
    root,
    view({ title: "待处理（多状态）", dql: "type = 'TASK' and state in ('DEFINED', 'DRAFT')" }),
    watch,
    deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }),
  );
  // SSR-000090 AC-16: the gate reuses the same slice, so an unsliceable DQL is
  // refused here rather than silently guessed at dispatch time.
  assert.match(result, /state/);
  assert.match(result, /待处理（多状态）/);
});

test("a template without {{key}} is a configuration error, naming the file and the placeholder", async () => {
  const { root, watch } = fixture();
  // The prompt is only what the template writes, so this template dispatches a
  // session that cannot tell which entity it owns — the executor can only guess
  // with a `list` (AC-12). Refusing it here is the whole point of the check.
  writeFileSync(watch.prompt, "按任务说明把这件事做完，派发方会把 key 交给你。\n");
  const result = await validate(
    root,
    view({ title: "待开工任务" }),
    watch,
    deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }),
  );
  assert.ok(result, "a template without {{key}} must be refused");
  assert.match(result, /\{\{key\}\}/);
  assert.ok(result.includes(watch.prompt), "the sentence must name the template file");
  assert.match(result, /待开工任务/, "and the view it belongs to");
});

test("a template with {{key}} validates", async () => {
  const { root, watch } = fixture();
  writeFileSync(watch.prompt, "你在处理 {{key}}（{{type}}），当前状态 {{state}}。\n");
  const result = await validate(root, view(), watch, deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }));
  assert.equal(result, null);
});

test("an unknown placeholder is not a configuration error", async () => {
  const { root, watch } = fixture();
  // {{foo}} is left in place by the renderer so a typo stays visible; a template
  // that asks for something we do not know is not refused for it.
  writeFileSync(watch.prompt, "处理 {{key}}；{{foo}} 原样保留。\n");
  const result = await validate(root, view(), watch, deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }));
  assert.equal(result, null);
});

test("only {{key}} is required: a template with nothing else still validates", async () => {
  const { root, watch } = fixture();
  writeFileSync(watch.prompt, "{{key}}\n");
  const result = await validate(root, view(), watch, deps({ ok: true, value: { validStates: TASK_STATES, routes: okRoutes } }));
  assert.equal(result, null);
});

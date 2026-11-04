import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseSubscriptionsYaml,
  normalizeAction,
  withParams,
  configPathFor,
  readSubscriptionConfig,
  streamUrlWithCid,
} = await jiti.import("./config.ts");

test("parses the documented shape: name, url, params, filter, action", () => {
  const { sources, error } = parseSubscriptionsYaml(`
subscriptions:
  - name: Entity
    url: http://localhost:3000/entity/events/stream
    params:
      entityTypes: MR,OR
      types: entity.created,entity.transitioned
      workspaceId: ws_entity_base
    filter: 'aggregateType == "MR" && payload.toState == "DEFINED"'
    action: new-task
`);
  assert.equal(error, null);
  assert.equal(sources.length, 1);
  const [source] = sources;
  assert.equal(source.name, "Entity");
  assert.equal(source.action, "new-task");
  assert.equal(source.filter, 'aggregateType == "MR" && payload.toState == "DEFINED"');
  // Params land in the URL in the order the backend documents them.
  const url = new URL(source.url);
  assert.equal(url.pathname, "/entity/events/stream");
  assert.equal(url.searchParams.get("entityTypes"), "MR,OR");
  assert.equal(url.searchParams.get("types"), "entity.created,entity.transitioned");
  assert.equal(url.searchParams.get("workspaceId"), "ws_entity_base");
});

test("accepts list params, apiKeyEnv, and the Chinese action words", () => {
  process.env.PI_TEST_SUB_KEY = "from-env";
  const { sources } = parseSubscriptionsYaml(`
subscriptions:
  - name: Entity
    url: http://localhost:3000/entity/events/stream
    params:
      entityTypes: [MR, OR, PCA]
    apiKeyEnv: PI_TEST_SUB_KEY
    action: notify
`);
  assert.equal(new URL(sources[0].url).searchParams.get("entityTypes"), "MR,OR,PCA");
  assert.equal(sources[0].apiKey, "from-env");
  assert.equal(sources[0].action, "notify");
  delete process.env.PI_TEST_SUB_KEY;
});

test("keeps the optional task prompt, block scalars included", () => {
  const { sources, error } = parseSubscriptionsYaml(`
subscriptions:
  - name: Entity
    url: http://localhost:1/stream
    action: new-task
    prompt: |
      核对这条变更。
      不要推送。
`);
  assert.equal(error, null);
  assert.equal(sources[0].action, "new-task");
  assert.equal(sources[0].prompt, "核对这条变更。\n不要推送。");

  const noPrompt = parseSubscriptionsYaml("subscriptions:\n  - url: http://localhost:1/stream\n");
  assert.equal(noPrompt.sources[0].prompt, "");

  const badPrompt = parseSubscriptionsYaml("subscriptions:\n  - url: http://localhost:1/stream\n    prompt: [1, 2]\n");
  assert.match(badPrompt.error, /prompt must be a string/);
});

test("accepts only the two English action words", () => {
  assert.equal(normalizeAction("new-task"), "new-task");
  assert.equal(normalizeAction("notify"), "notify");
  // Case and surrounding space are forgiven; spelling is not.
  assert.equal(normalizeAction(" New-Task "), "new-task");
  assert.equal(normalizeAction(undefined), "notify");

  for (const value of ["新建任务", "仅通知", "NEW TASK", "newtask", "task", "nope", 7]) {
    assert.equal(normalizeAction(value), null, `"${value}" must be rejected`);
  }
});

test("an unknown action is reported instead of silently becoming notify", () => {
  const { sources, error } = parseSubscriptionsYaml(`
subscriptions:
  - name: Entity
    url: http://localhost:1/stream
    action: 仅通知
`);
  assert.equal(sources.length, 0);
  assert.match(error, /Entity: action must be notify or new-task/);
});

test("the consumer id is stable per source and workspace, and never shared", () => {
  const a = streamUrlWithCid("http://localhost:3000/entity/events/stream?types=x", "D:/p/a", "Entity");
  const again = streamUrlWithCid("http://localhost:3000/entity/events/stream?types=x", "D:/p/a", "Entity");
  const otherSource = streamUrlWithCid("http://localhost:3000/entity/events/stream?types=x", "D:/p/a", "Entity-OR");
  const otherWorkspace = streamUrlWithCid("http://localhost:3000/entity/events/stream?types=x", "D:/p/b", "Entity");

  // Stable across restarts: the restart must supersede its own zombie connection.
  assert.equal(a, again);
  const cid = new URL(a).searchParams.get("cid");
  assert.match(cid, /^pi-agent-[0-9a-f]{16}$/);
  // Distinct per source and per workspace: two subscriptions never kick each other.
  assert.notEqual(new URL(otherSource).searchParams.get("cid"), cid);
  assert.notEqual(new URL(otherWorkspace).searchParams.get("cid"), cid);
  // The parameters from subscriptions.yaml survive.
  assert.equal(new URL(a).searchParams.get("types"), "x");
});

test("a cid written in the yaml wins", () => {
  const url = streamUrlWithCid("http://localhost:3000/stream?cid=my-tab", "D:/p/a", "Entity");
  assert.equal(new URL(url).searchParams.get("cid"), "my-tab");
});

test("keeps explicit query parameters instead of overwriting them", () => {  const url = withParams("http://localhost:3000/stream?workspaceId=ws_a", { workspaceId: "ws_b", types: "x" });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("workspaceId"), "ws_a");
  assert.equal(parsed.searchParams.get("types"), "x");
});

test("reports broken sources instead of dropping them silently", () => {
  const missingUrl = parseSubscriptionsYaml("subscriptions:\n  - name: Bad\n");
  assert.match(missingUrl.error, /Bad: url is required/);
  assert.equal(missingUrl.sources.length, 0);

  const badScheme = parseSubscriptionsYaml("subscriptions:\n  - url: file:///etc/passwd\n");
  assert.match(badScheme.error, /http or https/);

  const relative = parseSubscriptionsYaml("subscriptions:\n  - url: /entity/events/stream\n");
  assert.match(relative.error, /not an absolute URL/);
});

test("surfaces yaml and shape errors", () => {
  assert.match(parseSubscriptionsYaml("subscriptions: [").error, /YAML 解析失败/);
  assert.match(parseSubscriptionsYaml("other: 1").error, /缺少 subscriptions 列表/);
  assert.match(parseSubscriptionsYaml("subscriptions:\n  - name: X\n    url: http://a/b\n    params: nope").error, /params must be a mapping/);
});

test("an empty file is an empty subscription list, not an error", () => {
  const parsed = parseSubscriptionsYaml("");
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.sources, []);
});

test("also looks in the project's .pi directory, and prefers the workspace root", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-subconfig-"));
  const piDir = join(dir, ".pi");
  mkdirSync(piDir);
  writeFileSync(join(piDir, "subscriptions.yaml"), "subscriptions:\n  - name: FromDotPi\n    url: http://localhost:1/stream\n");

  assert.equal(configPathFor(dir), join(piDir, "subscriptions.yaml"));
  assert.equal(readSubscriptionConfig(dir).sources[0].name, "FromDotPi");

  // A file at the workspace root wins: it is the more obvious place.
  writeFileSync(join(dir, "subscriptions.yaml"), "subscriptions:\n  - name: FromRoot\n    url: http://localhost:1/stream\n");
  assert.equal(configPathFor(dir), join(dir, "subscriptions.yaml"));
  assert.equal(readSubscriptionConfig(dir).sources[0].name, "FromRoot");
});

test("a workspace with no file anywhere reports the path it looked for", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-subconfig-empty-"));
  const config = readSubscriptionConfig(dir);
  assert.equal(config.exists, false);
  assert.equal(config.error, null);
  assert.deepEqual(config.sources, []);
  assert.equal(config.path, join(dir, "subscriptions.yaml"));
});

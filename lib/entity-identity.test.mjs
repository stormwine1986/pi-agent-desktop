import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  declaredIdentityOf,
  identityFrom,
  identityMismatchRefusal,
  judgeConsistency,
  judgeIdentity,
} = await jiti.import("./entity-identity.ts");

// `SSR-000091` fixed where the declaration lives: `initialize.serverInfo._meta`,
// with `about_me` repeating the same object. These pin the reading order and the
// four outcomes ENV-RESOLVE asks for, without touching a network.

const handshake = (meta) => ({
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "Entity MCP Streamable HTTP Server", version: "1.0.0", _meta: meta },
});

test("the declaration is read from initialize.serverInfo._meta", () => {
  assert.deepEqual(
    declaredIdentityOf(handshake({ instanceId: "ins_demo", instanceName: "演示环境", appVersion: "abc123" })),
    { instanceId: "ins_demo", instanceName: "演示环境", appVersion: "abc123" },
  );
});

test("a serverInfo without the key declares nothing — not an empty string", () => {
  // ENV-ID ⑥: absence is a missing key, never null / "" / "unknown". Reading a
  // placeholder as a declaration would refuse a perfectly good link.
  assert.equal(declaredIdentityOf({ name: "x", version: "1.0.0" }), null);
  assert.equal(declaredIdentityOf(handshake({ instanceId: null })), null);
  assert.equal(declaredIdentityOf(handshake({ instanceId: "  " })), null);
  assert.equal(declaredIdentityOf(handshake({ instanceId: "unknown" })), null);
  assert.equal(declaredIdentityOf(null), null);
});

test("about_me repeats the same object, so the secondary check can compare it", () => {
  assert.deepEqual(
    identityFrom({ userId: "evan", instanceId: "ins_demo", instanceName: "演示环境" }),
    { instanceId: "ins_demo", instanceName: "演示环境" },
  );
  assert.deepEqual(identityFrom({ userId: "evan", environment: { instanceId: "ins_demo" } }), { instanceId: "ins_demo" });
});

test("a declared instance the link asked for is verified, and the id is kept for attribution", () => {
  const decided = judgeIdentity({
    server: "entity-base",
    actual: { instanceId: "ins_demo", instanceName: "演示环境" },
    requested: "ins_demo",
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.identity.verdict, "verified");
  assert.equal(decided.identity.instanceId, "ins_demo");
  assert.equal(decided.identity.expected, "ins_demo");
  assert.equal(decided.identity.source, "link");
  assert.match(decided.identity.detail, /ins_demo/);
});

test("a declared instance with no comparator is opened but marked 未验真", () => {
  // AC-5b: no pin, no link declaration → consistency check only. Never refused,
  // never called verified.
  const decided = judgeIdentity({ server: "entity-base", actual: { instanceId: "ins_demo" } });
  assert.equal(decided.ok, true);
  assert.equal(decided.identity.verdict, "unverified");
  assert.equal(decided.identity.expected, undefined);
  assert.match(decided.identity.detail, /未验真/);
  assert.match(decided.identity.detail, /未 pin/);
});

test("a deployment pin is the comparator when the link carries none", () => {
  const decided = judgeIdentity({ server: "entity-base", actual: { instanceId: "ins_demo" }, pinned: "ins_demo" });
  assert.equal(decided.ok, true);
  assert.equal(decided.identity.verdict, "verified");
  assert.equal(decided.identity.source, "config");
});

test("a link asking for another environment is refused, with code / expected / actual", () => {
  // AC-1 / AC-5a: the copy names what was required and what answered, and says
  // what the reader can do about it.
  const decided = judgeIdentity({
    server: "entity-base",
    actual: { instanceId: "ins_test", instanceName: "测试环境" },
    requested: "ins_demo",
    candidates: [{ server: "entity-base", instanceId: "ins_test", instanceName: "测试环境" }],
  });
  assert.equal(decided.ok, false);
  assert.equal(decided.refusal.code, "INSTANCE_MISMATCH");
  assert.equal(decided.refusal.status, 409);
  assert.equal(decided.refusal.expected, "ins_demo");
  assert.equal(decided.refusal.actual, "ins_test");
  assert.match(decided.refusal.error, /INSTANCE_MISMATCH/);
  assert.match(decided.refusal.error, /ins_demo/);
  assert.match(decided.refusal.error, /测试环境/);
  assert.match(decided.refusal.error, /mcp\.json/);
});

test("a pin that disagrees with the endpoint is refused as well", () => {
  const decided = judgeIdentity({ server: "entity-base", actual: { instanceId: "ins_test" }, pinned: "ins_demo" });
  assert.equal(decided.ok, false);
  assert.equal(decided.refusal.expected, "ins_demo");
  assert.equal(decided.refusal.actual, "ins_test");
});

test("a link that contradicts this project's pin is refused before anything opens", () => {
  const decided = judgeIdentity({
    server: "entity-base",
    actual: { instanceId: "ins_demo" },
    requested: "ins_other",
    pinned: "ins_demo",
  });
  assert.equal(decided.ok, false);
  assert.equal(decided.refusal.expected, "ins_other");
  assert.match(decided.refusal.error, /pin/);
});

test("an undeclared environment degrades instead of being refused", () => {
  // ENV-ID ⑥ / ENV-RESOLVE ③: an older deployment has no identity to compare;
  // it opens through the degraded path and is labelled, not killed.
  const decided = judgeIdentity({ server: "old-stack", actual: null, requested: "ins_demo" });
  assert.equal(decided.ok, true);
  assert.equal(decided.identity.verdict, "degraded");
  assert.equal(decided.identity.instanceId, undefined);
  assert.equal(decided.identity.expected, "ins_demo");
  assert.match(decided.identity.detail, /未声明身份/);
  assert.match(decided.identity.detail, /降级/);
});

test("two places of one connection that disagree are refused, not averaged", () => {
  const conflict = judgeConsistency({
    server: "entity-base",
    primary: { instanceId: "ins_demo" },
    secondary: { instanceId: "ins_test" },
  });
  assert.ok(conflict);
  assert.equal(conflict.code, "INSTANCE_MISMATCH");
  assert.match(conflict.error, /about_me/);
  assert.equal(judgeConsistency({ server: "entity-base", primary: { instanceId: "ins_demo" }, secondary: null }), null);
  assert.equal(
    judgeConsistency({ server: "entity-base", primary: { instanceId: "ins_demo" }, secondary: { instanceId: "ins_demo" } }),
    null,
  );
});

test("a refusal can carry a custom reason and still names every candidate", () => {
  const refusal = identityMismatchRefusal({
    server: "已配置的 server",
    why: "链接要求的环境与已配置 server 自报的环境都不一致",
    expected: "ins_demo",
    actual: "ins_test",
    candidates: [
      { server: "demo-a", instanceId: "ins_test", instanceName: "测试环境" },
      { server: "demo-b", instanceId: "ins_beta" },
    ],
  });
  assert.equal(refusal.expected, "ins_demo");
  assert.match(refusal.error, /demo-a/);
  assert.match(refusal.error, /demo-b/);
  assert.equal(refusal.candidates.length, 2);
});

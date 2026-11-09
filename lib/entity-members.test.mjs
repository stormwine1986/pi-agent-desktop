import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@": process.cwd() } });
const {
  normalizeMembers,
  memberLabel,
  memberDetail,
  memberOf,
  userValues,
  unknownMembers,
} = await jiti.import("./entity-members.ts");

// What `list_workspace_members` actually answers in the demo stack: one row per
// *role assignment*, so a person with three roles arrives three times.
const roles = [
  { workspaceId: "ws_entity_base", userId: "usr_1", username: "jiapei", email: "jiapei@entity.com", roleCode: "ADMIN", roleName: "系统管理员" },
  { workspaceId: "ws_entity_base", userId: "usr_2", username: "evan", email: "evan@entity.com", roleCode: "RD", roleName: "研发工程师" },
  { workspaceId: "ws_entity_base", userId: "usr_1", username: "jiapei", email: "jiapei@entity.com", roleCode: "PRODUCT", roleName: "产品经理" },
  { workspaceId: "ws_entity_base", userId: "usr_3", username: "alice", email: "alice@entity.com", roleCode: "RD", roleName: "研发工程师" },
];

test("a person appears once, even when the base reports one row per role", () => {
  const members = normalizeMembers(roles);
  assert.deepEqual(members.map((member) => member.username), ["alice", "evan", "jiapei"]);
  assert.equal(members.filter((member) => member.username === "jiapei").length, 1);
  // The first row's identity wins; the extra rows only add a role.
  assert.equal(memberOf(members, "jiapei").roleName, "系统管理员");
});

test("the order is stable and locale-free, so every render agrees", () => {
  const members = normalizeMembers([...roles].reverse());
  assert.deepEqual(members.map((member) => member.username), ["alice", "evan", "jiapei"]);
});

test("rows without a username are dropped, never invented", () => {
  const members = normalizeMembers([{ email: "nobody@entity.com" }, null, "nope", { username: "  " }, { username: " evan " }]);
  assert.deepEqual(members.map((member) => member.username), ["evan"]);
});

test("an unfamiliar wrapper is accepted; anything else is an empty list", () => {
  assert.deepEqual(normalizeMembers({ members: roles }).length, 3);
  assert.deepEqual(normalizeMembers({ items: roles }).length, 3);
  assert.deepEqual(normalizeMembers(null), []);
  assert.deepEqual(normalizeMembers("nope"), []);
});

test("the display name is a label, never the value", () => {
  const members = normalizeMembers([{ username: "evan", displayName: "Evan Li", email: "evan@entity.com" }]);
  assert.equal(memberLabel(members[0]), "Evan Li");
  assert.equal(memberDetail(members[0]), "evan@entity.com");
  // No display name declared → the username is what the reader sees.
  assert.equal(memberLabel({ username: "alice", displayName: "", email: "", roleName: "" }), "alice");
});

test("reading a value keeps its shape instead of joining it into one username", () => {
  assert.deepEqual(userValues("evan"), ["evan"]);
  assert.deepEqual(userValues(["evan", "alice"]), ["evan", "alice"]);
  assert.deepEqual(userValues(["evan", "evan", " alice ", ""]), ["evan", "alice"]);
  assert.deepEqual(userValues(["evan", 42, null]), ["evan"]);
  assert.deepEqual(userValues(""), []);
  assert.deepEqual(userValues(null), []);
  // An array is never turned into a comma string (SSR-000093 AC-5).
  assert.notEqual(userValues(["evan", "alice"]), "evan,alice");
});

test("usernames the list does not know are named, not silently dropped", () => {
  const members = normalizeMembers(roles);
  assert.deepEqual(unknownMembers(["evan", "ghost"], members), ["ghost"]);
  assert.deepEqual(unknownMembers(["evan"], members), []);
});

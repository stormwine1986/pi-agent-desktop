import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { allows, availableRoutesOf, rolesIn, writableFieldsOf } = await jiti.import("./entity-permissions.ts");

test("an empty, missing or starred list restricts nobody", () => {
  assert.equal(allows([], ["RD"]), true);
  assert.equal(allows(undefined, []), true);
  assert.equal(allows(["*"], []), true);
  assert.equal(allows(["PRODUCT"], ["RD"]), false);
});

test("role matching ignores case, as the base does", () => {
  assert.equal(allows(["rd"], ["RD"]), true);
  assert.equal(allows(["RD"], ["rd"]), true);
});

test("roles are the union of global and this workspace's, and only this one", () => {
  const me = {
    globalRoles: ["ADMIN"],
    workspaceRoles: [
      { id: "ws_manhu", roles: ["RD"] },
      { id: "ws_other", roles: ["PRODUCT"] },
    ],
  };
  assert.deepEqual(new Set(rolesIn(me, "ws_manhu")), new Set(["ADMIN", "RD"]));
  // A role held in another space must not leak into this one.
  assert.equal(rolesIn(me, "ws_missing").includes("PRODUCT"), false);
});

/** OR as the base defines it: `write` gated by state, `priority` read-only for RD. */
const orMetadata = {
  permissions: { read: [], write: ["RD", "RD_AGENT"] },
  fields: [
    { name: "name", permissions: { read: [], write: { DRAFT: ["RD"] } } },
    { name: "description", permissions: { read: [], write: { DRAFT: ["RD"] } } },
    { name: "priority", permissions: { read: ["RD"], write: { DRAFT: ["RD"] } } },
    { name: "state" },
  ],
};

test("a writer gets the fields its state allows", () => {
  assert.deepEqual(
    writableFieldsOf(orMetadata, "DRAFT", ["RD"]),
    ["name", "description", "priority"],
  );
});

test("a state with no entry makes every gated field read-only", () => {
  // Not "inherit the DRAFT entry" — that is the rule that reads wrong most often.
  assert.deepEqual(writableFieldsOf(orMetadata, "DEFINED", ["RD"]), []);
});

test("a reader outside the type-level write list writes nothing", () => {
  assert.deepEqual(writableFieldsOf(orMetadata, "DRAFT", ["PRODUCT"]), []);
});

test("a state field is never writable, however it is named", () => {
  assert.equal(writableFieldsOf(orMetadata, "DRAFT", ["RD"]).includes("state"), false);
  // The base marks it by type; a type that calls it something else must not
  // turn into a text box either.
  const renamed = {
    permissions: { write: [] },
    fields: [{ name: "status", type: "state" }, { name: "remarks" }],
  };
  assert.deepEqual(writableFieldsOf(renamed, "DRAFT", ["RD"]), ["remarks"]);
});

test("a field with no permissions at all is writable, and the type list still gates it", () => {
  const metadata = {
    permissions: { write: [] },
    fields: [{ name: "remarks" }],
  };
  assert.deepEqual(writableFieldsOf(metadata, "DRAFT", ["RD"]), ["remarks"]);
  assert.deepEqual(writableFieldsOf({ ...metadata, permissions: { write: ["PRODUCT"] } }, "DRAFT", ["RD"]), []);
});

/** MR as the base defines it: one route with requirements, one without. */
const mrMetadata = {
  lifecycle: {
    routes: [
      { from: "CREATED", to: "IN_REVIEW", name: "提交审核", requiredFields: ["description", "source"], permissions: ["PRODUCT"] },
      { from: "CREATED", to: "INVALID", name: "无效", requiredFields: [], permissions: ["PRODUCT"] },
      { from: "DEFINED", to: "ASSIGNED", name: "指派", requiredFields: [], permissions: ["PRODUCT", "RD_AGENT"] },
    ],
  },
  validityRules: {
    stateRequiredFields: { IN_REVIEW: ["background"], DEFINED: ["description"] },
  },
};

test("only routes leaving the current state are offered", () => {
  assert.deepEqual(availableRoutesOf(mrMetadata, "CREATED", ["PRODUCT"]).map((route) => route.to), ["IN_REVIEW", "INVALID"]);
  assert.deepEqual(availableRoutesOf(mrMetadata, "DEFINED", ["PRODUCT"]).map((route) => route.to), ["ASSIGNED"]);
});

test("a terminal state offers nothing", () => {
  assert.deepEqual(availableRoutesOf(mrMetadata, "INVALID", ["PRODUCT"]), []);
});

test("a route outside the reader's roles is not offered", () => {
  assert.deepEqual(availableRoutesOf(mrMetadata, "DEFINED", ["RD"]), []);
});

test("requirements are the route's own plus what the destination needs", () => {
  // The base checks required fields against the target state, so the panel has
  // to ask for both lists — IN_REVIEW needs `background` even though the route
  // itself does not name it.
  const [route] = availableRoutesOf(mrMetadata, "CREATED", ["PRODUCT"]);
  assert.deepEqual(route.required, ["description", "source", "background"]);
});

test("a route that asks for nothing reports no requirements", () => {
  const route = availableRoutesOf(mrMetadata, "CREATED", ["PRODUCT"]).find((item) => item.to === "INVALID");
  assert.deepEqual(route.required, []);
});

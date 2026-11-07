import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { allows, availableRoutesOf, canManageTraceOf, linkOptionsOf, rolesIn, writableFieldsOf } = await jiti.import("./entity-permissions.ts");

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

/** OR as `get_metadata` reports it: one relation to MR, one role that may write. */
const orWithTrace = {
  permissions: { read: [], write: ["RD"] },
  traceability: [
    {
      name: "satisfies",
      inverseName: "is_satisfied_by",
      description: "解决了哪些市场痛点",
      targetEntityTypes: ["MR"],
      allowedSourceStates: ["DRAFT", "DEFINED"],
      allowedTargetStates: ["CREATED", "DEFINED"],
      permissions: [],
    },
  ],
};

test("a declared relation is offered while the source state allows it", () => {
  const [option] = linkOptionsOf(orWithTrace, "DRAFT", ["RD"]);
  assert.equal(option.linkType, "satisfies");
  assert.deepEqual(option.targetTypes, ["MR"]);
  assert.equal(option.canLink, true);
  assert.equal(option.blockedBy, null);
});

test("a relation the source state forbids is offered but blocked, with its reason", () => {
  const [option] = linkOptionsOf(orWithTrace, "INVALID", ["RD"]);
  assert.equal(option.canLink, false);
  assert.equal(option.blockedBy, "state");
});

test("no type-level write means no relation can be created", () => {
  const [option] = linkOptionsOf(orWithTrace, "DRAFT", ["PRODUCT"]);
  assert.equal(option.canLink, false);
  assert.equal(option.blockedBy, "role");
});

test("a relation's own permissions narrow the type-level write", () => {
  // The base asks for both gates on a create: write on the type, then the
  // relation's roles. A relation can therefore only take rights away.
  const narrowed = {
    permissions: { read: [], write: ["RD", "RD_AGENT"] },
    traceability: [{ ...orWithTrace.traceability[0], permissions: ["RD"] }],
  };
  assert.equal(linkOptionsOf(narrowed, "DRAFT", ["RD"])[0].canLink, true);
  assert.equal(linkOptionsOf(narrowed, "DRAFT", ["RD_AGENT"])[0].canLink, false);
});

test("a type that declares no relation offers none", () => {
  assert.deepEqual(linkOptionsOf({ permissions: { write: ["RD"] } }, "DRAFT", ["RD"]), []);
});

test("removing a link follows the owning side's write rule", () => {
  assert.equal(canManageTraceOf(orWithTrace, "satisfies", ["RD"]), true);
  assert.equal(canManageTraceOf(orWithTrace, "satisfies", ["PRODUCT"]), false);
});

test("a retired relation keeps its links removable", () => {
  // The model no longer names it, so only the type-level gate remains — which
  // is exactly what lets existing links be unlinked but not re-created.
  const retired = { permissions: { write: ["RD"] } };
  assert.equal(canManageTraceOf(retired, "targets", ["RD"], { allowRetired: true }), true);
  assert.equal(canManageTraceOf(retired, "targets", ["RD"]), false);
  assert.equal(canManageTraceOf(retired, "targets", ["PRODUCT"], { allowRetired: true }), false);
});

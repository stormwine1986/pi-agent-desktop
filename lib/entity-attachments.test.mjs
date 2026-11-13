import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  attachmentCategoryLabel,
  attachmentCategoriesView,
  attachmentContentUrl,
  attachmentDeclarationOf,
  attachmentDisposition,
  attachmentFailure,
  attachmentGroups,
  categoryWriteBlock,
  formatAttachmentSize,
  normalizeAttachments,
  parseAttachmentView,
} = await jiti.import("./entity-attachments.ts");

// SSR-000126 (ATTM-PANEL): the panel renders what the base returned, states the
// model's write verdict, and downloads through REST. The base owns the read
// predicate — nothing here filters by read permission, deliberately.

/** A `get` attachment entry, as the base answers it. */
function attachment(overrides = {}) {
  return {
    id: "att_1",
    category: "note",
    fileName: "note.pdf",
    fileSize: 95,
    contentType: "application/pdf",
    description: "",
    sha256: "14fea7704c102aaa60754fb4da73ce9ee2002e67ca7892629e37408132830969",
    sourceRevision: 2,
    validFrom: "2026-11-13T06:53:18.541Z",
    createdAt: "2026-11-13T06:53:18.541Z",
    contentUrl: "/entity/attachments/att_1/content",
    ...overrides,
  };
}

/** A type definition with three categories, mirroring QAU on the test stack. */
const qauMetadata = {
  attachments: {
    permissions: { read: [], write: { DRAFT: ["RD"] } },
    categories: [
      {
        key: "note",
        label: "备注附件（公开读）",
        multiple: true,
        contentTypes: ["application/pdf", "image/png"],
        maxSizeMb: 20,
        permissions: { read: [], write: { DRAFT: ["RD", "PRODUCT"] } },
      },
      {
        key: "solution",
        label: "解决方案附件",
        multiple: false,
        contentTypes: [],
        maxSizeMb: 1,
        permissions: { read: ["RD", "ADMIN"], write: { DRAFT: ["RD"], DEFINED: [] } },
      },
      // No `permissions`: falls back to the type level (`SSR-000101` AC-3).
      { key: "spec", label: "规格附件", contentTypes: [], maxSizeMb: null },
    ],
  },
};

test("normalizes only the rows the base actually reported", () => {
  const rows = normalizeAttachments([
    attachment(),
    attachment({ id: "att_2", category: "solution", validFrom: "", createdAt: "2026-11-13T07:00:00Z" }),
    attachment({ id: "" }),
    "nonsense",
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uploadedAt, "2026-11-13T06:53:18.541Z");
  // `validFrom` is the effective time; `createdAt` is the fallback.
  assert.equal(rows[1].uploadedAt, "2026-11-13T07:00:00Z");
  assert.equal(rows[0].fileSize, 95);
});

test("an undeclared category reads as the implicit `default`", () => {
  const rows = normalizeAttachments([attachment({ category: undefined })]);
  assert.equal(rows[0].category, "default");
  assert.equal(attachmentCategoryLabel("default"), "默认附件");
  assert.equal(attachmentCategoryLabel("repro"), "repro");
});

test("reads the declared categories in declaration order", () => {
  const declaration = attachmentDeclarationOf(qauMetadata);
  assert.deepEqual(declaration.categories.map((category) => category.key), ["note", "solution", "spec"]);
  assert.equal(declaration.categories[0].label, "备注附件（公开读）");
  assert.equal(declaration.categories[1].multiple, false);
  assert.equal(declaration.categories[1].maxSizeMb, 1);
  // A type that declares nothing still only has the implicit `default`.
  assert.deepEqual(attachmentDeclarationOf({}).categories, []);
});

// --- the write verdict (`SSR-000101` merge fallback) -------------------------

test("a category's own state entry decides, including an empty freeze", () => {
  assert.equal(
    categoryWriteBlock({
      categoryWrite: { DEFINED: [] },
      typeWrite: { DRAFT: ["RD"] },
      state: "DEFINED",
      roles: ["RD"],
      entityWritable: true,
    }),
    "state",
  );
});

test("a category state entry with the role passes and does not fall through", () => {
  assert.equal(
    categoryWriteBlock({
      categoryWrite: { DRAFT: ["RD"] },
      typeWrite: { DRAFT: ["ADMIN"] },
      state: "DRAFT",
      roles: ["RD"],
      entityWritable: true,
    }),
    null,
  );
});

test("lacking the role is 'role', not 'state'", () => {
  assert.equal(
    categoryWriteBlock({
      categoryWrite: { DRAFT: ["RD"] },
      typeWrite: null,
      state: "DRAFT",
      roles: ["PRODUCT"],
      entityWritable: true,
    }),
    "role",
  );
});

test("a missing state key falls back rather than locking", () => {
  // `spec` declares nothing at all: the type-level rule answers.
  assert.equal(
    categoryWriteBlock({
      categoryWrite: null,
      typeWrite: { DRAFT: ["RD"] },
      state: "DRAFT",
      roles: ["RD"],
      entityWritable: true,
    }),
    null,
  );
  // The same reader in a state the type freezes.
  assert.equal(
    categoryWriteBlock({
      categoryWrite: null,
      typeWrite: { DRAFT: ["RD"], INVALID: [] },
      state: "INVALID",
      roles: ["RD"],
      entityWritable: false,
    }),
    "state",
  );
});

test("nothing declared anywhere falls back to the entity's own write answer", () => {
  assert.equal(
    categoryWriteBlock({ categoryWrite: null, typeWrite: null, state: "DRAFT", roles: ["RD"], entityWritable: true }),
    null,
  );
  assert.equal(
    categoryWriteBlock({ categoryWrite: null, typeWrite: null, state: "INVALID", roles: [], entityWritable: false }),
    "role",
  );
});

test("a plain role list is a decision for every state", () => {
  assert.equal(
    categoryWriteBlock({ categoryWrite: [], typeWrite: { DRAFT: ["RD"] }, state: "DRAFT", roles: ["RD"], entityWritable: true }),
    "state",
  );
  assert.equal(
    categoryWriteBlock({ categoryWrite: ["*"], typeWrite: [], state: "DRAFT", roles: [], entityWritable: false }),
    null,
  );
});

test("the panel states the freeze per category, not after a failed click", () => {
  const views = attachmentCategoriesView({
    metadata: qauMetadata,
    state: "DEFINED",
    roles: ["RD"],
    entityWritable: true,
    present: ["note", "solution", "spec"],
  });
  assert.deepEqual(views.map((view) => view.key), ["note", "solution", "spec"]);
  // note's own write map has no DEFINED entry → falls back to the type's DRAFT
  // map, which has no DEFINED entry either → the entity's answer.
  assert.equal(views[0].blockedBy, null);
  // solution: `DEFINED: []` is a decision — frozen in this state.
  assert.equal(views[1].blockedBy, "state");
  assert.equal(views[2].declared, true);
});

test("a category bound before the model declared it still gets a labelled group", () => {
  const views = attachmentCategoriesView({
    metadata: qauMetadata,
    state: "DRAFT",
    roles: ["RD"],
    entityWritable: true,
    present: ["note", "default"],
  });
  const fallback = views.find((view) => view.key === "default");
  assert.equal(fallback.declared, false);
  assert.equal(fallback.label, "默认附件");
});

test("groups keep declaration order, drop empties, and list the newest first", () => {
  const views = attachmentCategoriesView({
    metadata: qauMetadata,
    state: "DRAFT",
    roles: ["RD"],
    entityWritable: true,
    present: ["spec", "note", "solution"],
  });
  const groups = attachmentGroups(
    normalizeAttachments([
      attachment({ id: "att_old", category: "note", uploadedAt: "", validFrom: "2026-11-13T06:00:00Z" }),
      attachment({ id: "att_new", category: "note", validFrom: "2026-11-13T07:00:00Z" }),
      attachment({ id: "att_spec", category: "spec" }),
    ]),
    views,
  );
  assert.deepEqual(groups.map((group) => group.key), ["note", "spec"]);
  assert.deepEqual(groups[0].rows.map((row) => row.id), ["att_new", "att_old"]);
  assert.equal(groups[1].label, "规格附件");
});

test("an entity with no attachments has no groups at all", () => {
  assert.deepEqual(attachmentGroups([], []), []);
});

// --- the REST content URL (`SSR-000100`) ------------------------------------

test("builds the content URL from the configured entry, not from a reply url", () => {
  assert.equal(
    attachmentContentUrl({
      apiUrl: "http://localhost:3000/entity/mcp",
      contentUrl: "/entity/attachments/att_1/content",
    }),
    "http://localhost:3000/entity/attachments/att_1/content",
  );
  // A deployment mounted under a prefix keeps the prefix.
  assert.equal(
    attachmentContentUrl({
      apiUrl: "https://host/api/entity/mcp",
      contentUrl: "/entity/attachments/att_1/content",
    }),
    "https://host/api/entity/attachments/att_1/content",
  );
  // The proxy route builds it from the attachment id alone.
  assert.equal(
    attachmentContentUrl({ apiUrl: "http://localhost:3000/entity/mcp", contentUrl: "attachments/att_1/content" }),
    "http://localhost:3000/entity/attachments/att_1/content",
  );
});

test("a historic view travels to REST as a query parameter", () => {
  const url = new URL(attachmentContentUrl({
    apiUrl: "http://localhost:3000/entity/mcp",
    contentUrl: "/entity/attachments/att_1/content",
    revision: 3,
  }));
  assert.equal(url.searchParams.get("revision"), "3");
  assert.equal(url.searchParams.get("asOf"), null);

  const timed = new URL(attachmentContentUrl({
    apiUrl: "http://localhost:3000/entity/mcp",
    contentUrl: "/entity/attachments/att_1/content",
    revision: null,
    asOf: "2026-11-12T04:16:30.000Z",
  }));
  assert.equal(timed.searchParams.get("asOf"), "2026-11-12T04:16:30.000Z");
  assert.equal(timed.searchParams.get("revision"), null);
});

test("a url that cannot be parsed builds nothing", () => {
  assert.equal(attachmentContentUrl({ apiUrl: "not a url", contentUrl: "/entity/x" }), null);
  assert.equal(attachmentContentUrl({ apiUrl: "http://h/entity/mcp", contentUrl: "" }), null);
});

test("sets a save name the panel chose, with an ascii fallback", () => {
  assert.equal(
    attachmentDisposition("note.pdf"),
    "attachment; filename=\"note.pdf\"; filename*=UTF-8''note.pdf",
  );
  const unicode = attachmentDisposition('取证 "材料".pdf');
  assert.match(unicode, /^attachment; filename=".*\.pdf"/);
  assert.match(unicode, /filename\*=UTF-8''%E5%8F%96%E8%AF%81/);
  // Quotes and newlines cannot break out of the header.
  assert.equal(attachmentDisposition("\r\nEvil").includes("\r"), false);
});

test("formats a size the way the rest of the app does", () => {
  assert.equal(formatAttachmentSize(95), "95 B");
  assert.equal(formatAttachmentSize(2580), "2.5 KB");
  assert.equal(formatAttachmentSize(2 * 1024 * 1024), "2.0 MB");
  assert.equal(formatAttachmentSize(null), "未知大小");
});

// --- error contract (`SSR-000100` AC-6) ------------------------------------

test("every contract error becomes one actionable sentence", () => {
  const forbidden = attachmentFailure(403, {
    code: "PERMISSION_DENIED",
    statusCode: 403,
    retriable: false,
    message: "User is not authorized to read attachment 'att_x'",
  });
  assert.match(forbidden.error, /没有权限查看这个附件（403）/);
  assert.match(forbidden.error, /分类/);
  assert.equal(forbidden.code, "PERMISSION_DENIED");
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.retriable, false);

  const missing = attachmentFailure(404, { code: "ATTACHMENT_NOT_FOUND", statusCode: 404, retriable: false });
  assert.match(missing.error, /附件不存在/);

  const unavailable = attachmentFailure(503, { code: "ATTACHMENT_STORAGE_UNAVAILABLE", statusCode: 503, retriable: true });
  assert.match(unavailable.error, /存储暂时不可用（503）/);
  assert.equal(unavailable.retriable, true);

  const tooLarge = attachmentFailure(413, { code: "ATTACHMENT_TOO_LARGE", statusCode: 413, retriable: false });
  assert.match(tooLarge.error, /大小上限（413）/);
});

test("a body that broke the contract still gets a readable answer", () => {
  const bare = attachmentFailure(500, null);
  assert.match(bare.error, /服务器取附件时出错（500）/);
  assert.equal(bare.statusCode, 500);
  // The base's own wording never becomes the only explanation.
  assert.equal(bare.detail, undefined);
});

test("parses a view strictly instead of silently dropping it", () => {
  assert.deepEqual(parseAttachmentView(new URLSearchParams()), { revision: null, asOf: null });
  assert.deepEqual(parseAttachmentView(new URLSearchParams("revision=3")), { revision: 3, asOf: null });
  assert.deepEqual(
    parseAttachmentView(new URLSearchParams("asOf=2026-11-12T04:16:30Z")),
    { revision: null, asOf: "2026-11-12T04:16:30.000Z" },
  );
  assert.match(parseAttachmentView(new URLSearchParams("revision=3&asOf=2026-11-12")).error, /只能选一个/);
  assert.match(parseAttachmentView(new URLSearchParams("revision=0")).error, /正整数/);
  assert.match(parseAttachmentView(new URLSearchParams("revision=abc")).error, /正整数/);
  assert.match(parseAttachmentView(new URLSearchParams("asOf=yesterday")).error, /合法时间/);
});

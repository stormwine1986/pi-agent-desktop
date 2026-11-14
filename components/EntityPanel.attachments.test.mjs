import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// SSR-000126 ⑧ / AC-1: the panel reads the current revision, always. The
// historic-view control (「当前版本 / 修订 / 时点」) and the read-only
// `historyView` branch were removed by product decision, and a merged-in copy or
// a half-reverted branch is exactly the kind of regression a type checker cannot
// see — the panel would still compile and still work, just on an old revision.
//
// The REST capability itself is NOT removed (`SSR-000100` keeps `revision` /
// `asOf`): only the panel stops using it. Both halves are asserted below.
const panel = (await readFile(new URL("./EntityPanel.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const uploads = (await readFile(new URL("./EntityAttachmentUploads.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const downloadRoute = (await readFile(new URL("../app/api/entity/attachment/route.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

test("the panel no longer offers a historic view", () => {
  for (const marker of ["historyView", "openRevisionView", "openAsOfView", "backToCurrent", "revisionInput", "asOfInput", "viewError"]) {
    assert.equal(panel.includes(marker), false, `「${marker}」 still exists: the removed history view came back`);
  }
  for (const label of ["当前版本", "时点", "本轮只读"]) {
    assert.equal(panel.includes(label), false, `「${label}」 still rendered in the panel`);
  }
});

test("the panel no longer asks for a revision or a point in time", () => {
  // A stale query would silently read an old view even without a control.
  assert.equal(panel.includes('params.set("revision"'), false);
  assert.equal(panel.includes('params.set("asOf"'), false);
  assert.equal(panel.includes("?revision="), false);
});

test("the download route keeps revision/asOf: the capability shrank, the entry point did", () => {
  for (const marker of ["parseAttachmentView", "revision", "asOf"]) {
    assert.equal(downloadRoute.includes(marker), true, `the download proxy lost 「${marker}」`);
  }
  // …and the sha256 check plus the conditional/partial-read pass-through stay.
  for (const marker of ["etag", "content-range", "accept-ranges", "if-none-match"]) {
    assert.equal(downloadRoute.includes(marker), true, `the download proxy lost 「${marker}」`);
  }
});

test("uploads go through the two proxies, in two steps", () => {
  assert.equal(panel.includes("/api/entity/attachment/blob?"), true);
  assert.equal(panel.includes("/api/entity/attachment/bind?"), true);
  // Step order matters: content first, binding second.
  assert.equal(
    panel.indexOf("/api/entity/attachment/blob?") < panel.indexOf("/api/entity/attachment/bind?"),
    true,
  );
  // The declaration is applied before anything is sent.
  assert.equal(panel.includes("attachmentUploadPrecheck("), true);
  // The list is re-read from the base rather than patched in the browser.
  assert.equal(panel.includes("const refreshed = await load();"), true);
  // One upload at a time: a second click cannot start a second one.
  assert.match(panel, /if \(!data \|\| uploading !== null\) return;/);
});

test("the entries are rendered per category, not per existing attachment", () => {
  // The grouping of bound rows and the upload entries are different lists: an
  // empty declared category has no group but must still have an entry (AC-2).
  assert.equal(panel.includes("attachmentUploadEntries("), true);
  assert.equal(panel.includes("attachmentGroups("), true);
  assert.equal(panel.includes("<EntityAttachmentUploads"), true);
  assert.equal(uploads.includes("entry.blocked !== \"role\""), true, "a role-less category must not render an entry");
});

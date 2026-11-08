import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { clampOffset, pageWindow } = await jiti.import("./page.ts");

test("a page in the middle says how far it can go either way", () => {
  const window = pageWindow(50, 50, 320, 50);
  assert.equal(window.hasPrev, true);
  assert.equal(window.hasNext, true);
  assert.equal(window.total, 320);
});

test("the last page knows it is the last", () => {
  const window = pageWindow(300, 20, 320, 50);
  assert.equal(window.hasNext, false, "20 rows left over from 300 is the end");
  assert.equal(window.hasPrev, true);
});

test("an offset past the end steps back to the last real page", () => {
  // 320 rows, page size 50 → the last page starts at 300. Sitting on 350 after
  // rows disappeared must not answer with an empty list.
  assert.equal(clampOffset(350, 320, 50), 300);
  assert.equal(clampOffset(300, 320, 50), 300);
  assert.equal(clampOffset(50, 320, 50), 50);
});

test("an empty view always lands on the first page", () => {
  assert.equal(clampOffset(200, 0, 50), 0);
  assert.equal(clampOffset(50, 1, 50), 0);
});

test("without a total the offset is left alone", () => {
  // Nothing to clamp against; guessing would move the user somewhere arbitrary.
  assert.equal(clampOffset(400, null, 50), 400);
});

test("without a total, only a full page suggests there is more", () => {
  assert.equal(pageWindow(0, 50, null, 50).hasNext, true, "a full page may have a successor");
  assert.equal(pageWindow(0, 12, null, 50).hasNext, false, "a short page is the end");
});

test("a nonsense offset reads as the first page instead of failing", () => {
  assert.equal(clampOffset(Number.NaN, 320, 50), 0);
  assert.equal(clampOffset(-40, 320, 50), 0);
});

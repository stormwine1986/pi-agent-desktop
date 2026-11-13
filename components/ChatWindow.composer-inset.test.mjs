import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// DEFECT-000105 / TASK-000215. The composer floats over the scrollport, and the
// message list ends with a spacer so the last lines can scroll clear of it. The
// guarantee used to depend on four refs being non-null at the exact moment one
// effect ran, on the spacer element surviving a React remount, and on the window
// never getting shorter — each of which failed silently, leaving the spacer at 0
// or the tail off-screen. Measured on the shipped 0.10.0 payload (900×700, last
// message a 40-row markdown table, reader at the tail): after shrinking the
// window to 630×490 the last row sat 147.6 px *below* the composer's top edge
// (`clearance -147.6`, `gapToBottom 210`). With the fix: `clearance +62.4`,
// `gapToBottom 0`.
//
// These are source assertions on purpose: the number that mattered is produced
// by the browser's layout, so a unit test cannot recompute it — what it can pin
// is that the four silent paths stay closed.
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const effect = /\/\/ The bottom composer floats over the scrollport[\s\S]*?\n  \}, \[isEmptyNew, scrollContainerRef\]\);/.exec(source)?.[0] ?? "";

test("the composer-inset effect is still the one that drives the spacer", () => {
  assert.ok(effect, "the composer inset effect must still exist in ChatWindow.tsx");
  assert.match(effect, /--chat-composer-inset/);
  assert.match(source, /const CHAT_COMPOSER_CLEARANCE = 8;/);
});

test("the spacer takes its height from the CSS variable, not from a write it can lose", () => {
  // A remounted spacer carries no inline height; the variable lives on the
  // region, so the spacer gets its height back without any effect re-running.
  assert.match(source, /ref=\{composerOverlaySpacerRef\}\s*\n\s*aria-hidden="true"\s*\n\s*style=\{\{ height: "var\(--chat-composer-inset, 0px\)" \}\}/);
  assert.doesNotMatch(effect, /spacer\.style\.height/);
});

test("a collapsed measurement is never written out, and the inset has a floor", () => {
  assert.match(effect, /const measured = Math\.ceil\(composer\.getBoundingClientRect\(\)\.height\);/);
  assert.match(effect, /if \(!\(measured > 0\)\) return;/);
  assert.match(effect, /Math\.max\(CHAT_COMPOSER_CLEARANCE, measured\)/);
  // Writing `0` is exactly the reported state; it must not be reachable.
  assert.doesNotMatch(effect, /`\$\{measured\}px`/);
});

test("a missing region falls back to scrollport padding instead of returning silently", () => {
  assert.doesNotMatch(effect, /if \(isEmptyNew \|\| !composer \|\| !spacer \|\| !region \|\| !container\) return;/);
  assert.match(effect, /container\.style\.paddingBottom = `\$\{next\}px`/);
  assert.match(effect, /console\.warn\("\[chat\] composer inset: region ref missing/);
});

test("a shorter window re-pins the tail only for a reader who was at the bottom", () => {
  assert.match(effect, /let following = true;/);
  assert.match(effect, /const onScroll = \(\) => \{\s*\n\s*following = gapToBottom\(\) <= 2;/);
  assert.match(effect, /new ResizeObserver\(\(\) => \{\s*\n\s*if \(following\) \{\s*\n\s*pinToTail\(\);/);
  // The content box grows when a narrower column re-wraps; a following reader
  // is re-pinned through that too.
  assert.match(effect, /contentObserver\.observe\(content\)/);
  assert.match(effect, /if \(following && gapToBottom\(\) > 2\) pinToTail\(\);/);
  assert.match(effect, /container\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
  assert.match(effect, /container\.removeEventListener\("scroll", onScroll\)/);
});

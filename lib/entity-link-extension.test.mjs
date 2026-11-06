import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ENTITY_LINK_GUIDE, ENTITY_LINK_SECTION, createEntityLinkExtension } =
  await jiti.import("./entity-link-extension.ts");
const { parseEntityItemHref } = await jiti.import("./entity-opener.ts");

test("adds the entity-link section without forcing the prompt", async () => {
  const handlers = [];
  const extension = createEntityLinkExtension();
  assert.equal(extension.hidden, true);
  await extension.factory({ on: (name, handler) => handlers.push([name, handler]) });
  assert.deepEqual(handlers.map(([name]) => name), ["before_agent_start"]);

  const event = { systemPromptOptions: { sections: {} } };
  const result = await handlers[0][1](event);
  assert.equal(result, undefined);
  assert.equal(event.systemPromptOptions.sections[ENTITY_LINK_SECTION], ENTITY_LINK_GUIDE);
});

test("the example in the guide is a link the panel can open", () => {
  const href = ENTITY_LINK_GUIDE.match(/\]\((entity-item:[^)]+)\)/)?.[1];
  assert.ok(href, "the guide must show a parseable example");
  assert.deepEqual(parseEntityItemHref(href), {
    server: "entity-base",
    workspace: "ws_manhu",
    key: "MR-000123",
  });
});

test("the guide tells the model not to link keys it did not see", () => {
  // Silence here would produce links to entities that do not exist, and a dead
  // link looks like a broken app rather than a bad reply.
  assert.match(ENTITY_LINK_GUIDE, /Never invent/);
  assert.match(ENTITY_LINK_GUIDE, /not seen in a tool result/);
  // The key must stay the visible text, or copying a reply yields a URL.
  assert.match(ENTITY_LINK_GUIDE, /link text is the key/i);
  // A table of keys is where this matters most, so the guide must say so.
  assert.match(ENTITY_LINK_GUIDE, /In a table or a list/);
});

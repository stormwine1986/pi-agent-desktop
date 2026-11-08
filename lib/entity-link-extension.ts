import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const ENTITY_LINK_EXTENSION_NAME = "pi-web-entity-links";
export const ENTITY_LINK_SECTION = "entity-links";

// Tells the model how to point at a domain object so the reply can open it.
//
// Sent with every request, so it stays short: the format, the "copy the key,
// never invent one" rule, and the "when not to" lines that keep a reply from
// turning into a wall of links. `lib/entity-opener.ts` is the other half — it
// parses exactly these hrefs.
export const ENTITY_LINK_GUIDE = `Some replies refer to domain objects (entities) that the user can open in a panel beside the chat. Write such a reference as a markdown link whose address is \`entity-item:\` followed by the server, the workspace and the key:

[MR-000123](entity-item:entity-base/ws_manhu/MR-000123)

The server is the name in the tool you called (\`mcp__<server>__<tool>\`, where pi writes a configured \`-\` as \`_\`); the workspace is the \`workspaceId\` in the tool result. If the reply is already about one server and workspace, \`entity-item:ws_manhu/MR-000123\` or even \`entity-item:MR-000123\` also works — but use the full form when the reply mixes workspaces.

Rules:
- The link text is the key itself, copied exactly as the tool returned it. Never invent, shorten or renumber a key.
- Link an entity only where the reply actually refers to it — a decision, a change, a problem. Not every mention, and never the same key twice in one paragraph.
- **In a table or a list, link the key in place.** The reader clicks those keys, so a bare \`MR-000123\` in a cell is a dead end: write \`[MR-000123](entity-item:entity-base/ws_manhu/MR-000123)\` inside the cell. Same in a bullet: link the key, keep the rest of the line plain.
- Do not link a key inside code, logs, or an example of a key. Plain text there, no markdown.
- A key you have not seen in a tool result this session is not a link; describe it instead.`;

export function createEntityLinkExtension(): InlineExtension {
  return {
    name: ENTITY_LINK_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections[ENTITY_LINK_SECTION] = ENTITY_LINK_GUIDE;
        return undefined;
      });
    },
  };
}

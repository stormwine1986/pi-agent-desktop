"use client";

// A reply points at a domain object with a link the panel can act on:
//
//   [MR-000123](entity-item:entity-base/ws_manhu/MR-000123)
//
// The key stays readable as the link text, so copying a reply yields plain text
// while clicking opens the object beside the conversation. The scheme is
// intercepted here rather than in `MarkdownBody` alone because the opener lives
// in `AppShell`, several layers up — the same reason `artifact-store` exists.
//
// Two forms are accepted. The full one names the channel and the space, which
// is what a reply can build from any tool result. The short one (`entity-item:MR-000123`)
// falls back to the channel used last, so a conversation about one project does
// not have to repeat it in every link.
//
// A link may also carry the environment declaration it was written against:
//
//   [MR-000123](entity-item:entity-base/ws_manhu/MR-000123?instanceId=ins_demo)
//
// That value says *which* environment the writer meant (`SSR-000092` ENV-RESOLVE
// 1); it is not evidence that the environment the reader reaches really is that
// one. Links without it — every link written before this existed — keep working
// and are marked "未验真" by the panel.

import { mcpServerKey } from "./mcp-server-name";

/** Where a link points when it omits the channel. */
export interface EntityChannel {
  server: string;
  workspace: string;
}

/**
 * The tab id for one entity.
 *
 * The server half is written the way pi namespaces a server (`-` as `_`), so a
 * key opened from a reply's link and the same key opened from a to-do row focus
 * one tab instead of two: the link can only carry the namespace spelling, while
 * the list carries the configured one.
 *
 * The folder is part of the identity too. The same reply can be read in two
 * projects, and each has its own `mcp.json`: `entity-demo-system-alice` in one,
 * `entity-base` in the other, with different tokens. A tab keyed only by channel
 * and key quietly reopened the *other* project's tab — same title, same key, the
 * other `mcp.json` behind it — which is how one key came to look "sometimes
 * working, sometimes not" while the folder in front of the reader was correct.
 */
export function entityTabId(
  cwd: string,
  server: string | undefined,
  workspace: string | undefined,
  key: string,
): string {
  return `entity:${cwd}:${server ? mcpServerKey(server) : "auto"}:${workspace ?? ""}:${key}`;
}

export interface EntityItemRequest {
  /** Undefined when the link named none; the server then resolves it. */
  server?: string;
  workspace?: string;
  key: string;
  /** The environment the writer meant, when the link carries it. */
  instanceId?: string;
}

/** What a link points at, before the panel resolves anything. */
export interface ParsedEntityItem {
  server?: string;
  workspace?: string;
  key: string;
  instanceId?: string;
}

const PREFIX = "entity-item:";

let opener: ((request: EntityItemRequest) => void) | null = null;
let lastChannel: EntityChannel | null = null;

/** Whether an href is one this module handles. */
export function isEntityItemHref(href: string | undefined | null): href is string {
  return typeof href === "string" && href.toLowerCase().startsWith(PREFIX);
}

/**
 * The parts of an `entity-item:` href, or null when it carries no usable key.
 *
 * `workspace/key` is accepted as well as `server/workspace/key`: a reply inside
 * one project usually knows the space from context and only needs the channel
 * prefix left off. A `?instanceId=` query names the environment; anything else
 * in the query is ignored rather than guessed at.
 */
export function parseEntityItemHref(href: string): ParsedEntityItem | null {
  if (!isEntityItemHref(href)) return null;
  const rest = href.slice(PREFIX.length).replace(/^\/+/, "").trim();
  if (!rest) return null;
  const hashAt = rest.indexOf("#");
  const withoutHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const queryAt = withoutHash.indexOf("?");
  const path = (queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash).trim();
  const query = queryAt >= 0 ? withoutHash.slice(queryAt + 1) : "";

  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const raw = query ? new URLSearchParams(query).get("instanceId")?.trim() : undefined;
  const declared = raw ? { instanceId: raw } : {};
  if (parts.length === 1) return { key: parts[0], ...declared };
  if (parts.length === 2) return { workspace: parts[0], key: parts[1], ...declared };
  return { server: parts[0], workspace: parts[1], key: parts.slice(2).join("/"), ...declared };
}

/**
 * The href for one entity, so a reply can write the declaration it opened with.
 *
 * Omitted parts stay omitted (the short forms above), so this does not force a
 * channel into a link that was fine without one.
 */
export function entityItemHref(input: { server?: string; workspace?: string; key: string; instanceId?: string }): string {
  const path = [input.server, input.workspace, input.key].filter((part) => Boolean(part)).join("/");
  const suffix = input.instanceId ? `?instanceId=${encodeURIComponent(input.instanceId)}` : "";
  return `${PREFIX}${path}${suffix}`;
}

/** Remembers which channel the current context reads from, for short links. */
export function setEntityChannel(channel: EntityChannel): void {
  lastChannel = channel;
}

export function setEntityOpener(handler: (request: EntityItemRequest) => void): () => void {
  opener = handler;
  return () => {
    if (opener === handler) opener = null;
  };
}

/**
 * Opens the object an `entity-item:` link names. Returns false when nothing
 * could be attempted, so the caller does not pretend it worked.
 *
 * A link with no channel is not a failure: the panel asks the project's servers
 * which one holds the entity. Only a missing opener stops it here.
 */
export function openEntityItemLink(href: string): boolean {
  const parsed = parseEntityItemHref(href);
  if (!parsed) return false;
  if (!opener) {
    console.warn(`[entity-item] 无法打开 ${href}：面板尚未注册打开器（可能还在加载）。`);
    return false;
  }
  opener({
    server: parsed.server ?? lastChannel?.server,
    workspace: parsed.workspace ?? lastChannel?.workspace,
    key: parsed.key,
    // Kept absent when the link carried none: "no declaration" is not an empty
    // one, and older links must reach the opener exactly as before.
    ...(parsed.instanceId ? { instanceId: parsed.instanceId } : {}),
  });
  return true;
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { EVENTS_CONFIG_RELATIVE_PATHS, parseEventsText, type EventSubscription } from "./config";

/**
 * Editing one rule of `.pi/events.yaml` from the panel (M3 / AC-3).
 *
 * The file is a document a person reads and commits, so the edit is **surgical**:
 * the block of that one subscription is located by indentation, and only the
 * lines of the keys being changed are rewritten. Everything else — other rules,
 * ordering, comments, quoting style, blank lines — is left byte-for-byte as it
 * was. Re-emitting the whole document through `js-yaml.dump()` would be easier
 * and would throw away every comment in the file, which is why it is not done.
 *
 * Validation is **not** duplicated here: the caller builds the candidate text,
 * runs it through `parseEventsText()` (the same function `readEventsConfig()`
 * uses, i.e. the M2 closed-set validator) and refuses to write if that says the
 * rule is broken. This module only reports *where* the offending key sits, so
 * the refusal can name a line.
 */

export interface EditTarget {
  sessionId: string;
  name: string;
}

/** The keys the panel may change. Everything else is the author's file. */
export interface SubscriptionPatch {
  action?: string;
  coalesceSec?: number | string;
  /** `null` removes the block; a list per key replaces it (an empty list removes that key). */
  match?: Record<string, string[] | string | null> | null;
}

export interface PatchSuccess {
  ok: true;
  text: string;
  /** The keys that were rewritten, for the UI's "已保存" line. */
  changed: string[];
  /** 1-based line of each key in the new text. */
  lines: Record<string, number>;
}

export interface PatchFailure {
  ok: false;
  /** Why the file could not be edited at all (the rule was not found, …). */
  error: string;
  line: number | null;
}

/**
 * A Windows editor (Notepad, VS Code with CRLF, `git config core.autocrlf`) can
 * hand this file over with CRLF. The scanner works on the normalised text and
 * puts the file's own line endings back, so an edit never silently converts a
 * project's whole file.
 */
function normalized(text: string): { body: string; crlf: boolean } {
  const crlf = text.includes("\r\n");
  return { body: crlf ? text.replace(/\r\n/g, "\n") : text, crlf };
}

interface Block {
  /** 0-based index of the `- name: …` line. */
  start: number;
  /** 0-based index one past the last line of the rule. */
  end: number;
  /** Column of the keys belonging to this rule (`- ` counted). */
  keyIndent: number;
  lines: string[];
}

function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].replace(/\t/g, "  ").length : 0;
}

/** A YAML scalar from a flow line: quotes and a trailing comment removed. */
function scalarOf(raw: string): string {
  let value = raw.trim();
  // A comment starts at " #" (a `#` inside quotes is not a comment; rule names
  // and state names in this file never contain one — `name` forbids it).
  const hash = value.indexOf(" #");
  if (hash >= 0) value = value.slice(0, hash).trim();
  if (hash < 0 && value.startsWith("#")) value = "";
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

/** 0-based index of the first line that is not blank and not a comment, from `from`. */
function nextContentLine(lines: string[], from: number, until: number): number {
  for (let index = from; index < until; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed && !trimmed.startsWith("#")) return index;
  }
  return -1;
}

/** One subscription item, found by `(sessionId, name)`; null when either is absent. */
export function findRuleBlock(rawText: string, target: EditTarget): Block | null {
  const text = normalized(rawText).body;
  const lines = text.split("\n");
  const sessionsLine = lines.findIndex((line) => /^sessions\s*:/.test(line.trim()));
  if (sessionsLine < 0) return null;

  let index = sessionsLine + 1;
  while (index < lines.length) {
    const sessionStart = /^(\s*)-\s+sessionId\s*:\s*(.*)$/.exec(lines[index]);
    if (!sessionStart) {
      index += 1;
      continue;
    }
    const sessionIndent = sessionStart[1].replace(/\t/g, "  ").length;
    // The session item runs to the next line at its own dash indentation.
    let sessionEnd = lines.length;
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const trimmed = lines[probe].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (indentOf(lines[probe]) <= sessionIndent) {
        sessionEnd = probe;
        break;
      }
    }
    if (scalarOf(sessionStart[2]) === target.sessionId) {
      const block = findSubscriptionInSession(lines, index, sessionEnd, target.name);
      if (block) return block;
    }
    index = sessionEnd;
  }
  return null;
}

function findSubscriptionInSession(lines: string[], from: number, until: number, name: string): Block | null {
  for (let index = from; index < until; index += 1) {
    const itemStart = /^(\s*)-\s+name\s*:\s*(.*)$/.exec(lines[index]);
    if (!itemStart) continue;
    const dashIndent = itemStart[1].replace(/\t/g, "  ").length;
    let end = until;
    for (let probe = index + 1; probe < until; probe += 1) {
      const trimmed = lines[probe].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (indentOf(lines[probe]) <= dashIndent) {
        end = probe;
        break;
      }
    }
    if (scalarOf(itemStart[2]) !== name) {
      index = end - 1;
      continue;
    }
    const firstKey = nextContentLine(lines, index + 1, end);
    const keyIndent = firstKey >= 0 ? indentOf(lines[firstKey]) : dashIndent + 2;
    return { start: index, end, keyIndent, lines: lines.slice(index, end) };
  }
  return null;
}

function escapeScalar(value: string): string {
  if (/^[A-Za-z0-9_.\-/*]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** `[a, b]`, or nothing when the predicate is empty (that key is then removed). */
function flowList(values: string[]): string {
  return `[${values.map(escapeScalar).join(", ")}]`;
}

/** Where a key of the patch lives in the document, for error messages (1-based). */
export function locateKey(rawText: string, target: EditTarget, key: string): number | null {
  const block = findRuleBlock(rawText, target);
  if (!block) return null;
  const [head, tail] = key.includes(".") ? key.split(".", 2) : [key, null];
  for (let offset = 0; offset < block.lines.length; offset += 1) {
    const line = block.lines[offset];
    const match = new RegExp(`^(\\s*)${head}\\s*:`).exec(line);
    if (!match) continue;
    if (tail === null) return block.start + offset + 1;
    const headIndent = match[1].replace(/\t/g, "  ").length;
    for (let probe = offset + 1; probe < block.lines.length; probe += 1) {
      const inner = block.lines[probe];
      if (!inner.trim() || inner.trim().startsWith("#")) continue;
      if (indentOf(inner) <= headIndent) break;
      const innerMatch = new RegExp(`^(\\s*)${tail}\\s*:`).exec(inner);
      if (innerMatch) return block.start + probe + 1;
    }
    return block.start + offset + 1;
  }
  return block.start + 1;
}

/**
 * Rewrites one rule's `action` / `coalesceSec` / `match:` block.
 *
 * Absent keys are inserted next to the existing ones (after `match:` when it is
 * there, otherwise at the end of the rule's keys), keeping their trailing
 * comments when the key already existed.
 */
export function applySubscriptionPatch(
  raw: string,
  target: EditTarget,
  patch: SubscriptionPatch,
): PatchSuccess | PatchFailure {
  const { body: text, crlf } = normalized(raw);
  const block = findRuleBlock(text, target);
  if (!block) {
    return { ok: false, error: `在 .pi/events.yaml 里找不到会话 ${target.sessionId} 的订阅「${target.name}」`, line: null };
  }
  const lines = text.split("\n");
  const working = [...block.lines];
  const changed: string[] = [];
  const pad = " ".repeat(block.keyIndent);

  const setScalar = (key: string, value: string): void => {
    const at = working.findIndex((line) => indentOf(line) === block.keyIndent && new RegExp(`^\\s*${key}\\s*:`).test(line));
    if (at >= 0) {
      // Rewrite the value only: the spaces that lined the comment up and the
      // comment itself stay exactly as the author wrote them.
      const pattern = new RegExp(`^(\\s*${key}\\s*:)(\\s*)(.*?)(\\s*)(#.*)?$`);
      const parts = pattern.exec(working[at]);
      working[at] = parts
        ? `${parts[1]}${parts[2] || " "}${value}${parts[4] ?? ""}${parts[5] ?? ""}`
        : `${pad}${key}: ${value}`;
    } else {
      const insertAt = insertionPoint(working, block.keyIndent, ["match"]);
      working.splice(insertAt, 0, `${pad}${key}: ${value}`);
    }
    changed.push(key);
  };

  if (typeof patch.action === "string") setScalar("action", patch.action);
  if (patch.coalesceSec !== undefined) setScalar("coalesceSec", String(patch.coalesceSec));

  if (patch.match !== undefined) {
    const matchIndex = working.findIndex(
      (line) => indentOf(line) === block.keyIndent && /^\s*match\s*:/.test(line),
    );
    const desired: [string, string][] = [];
    if (patch.match !== null) {
      for (const [key, value] of Object.entries(patch.match)) {
        const list = value === null ? [] : Array.isArray(value) ? value : [value];
        if (list.length === 0) continue;
        desired.push([key, flowList(list)]);
      }
    }
    if (matchIndex >= 0) {
      // Replace the key and its child lines (blank lines and comments inside the
      // replaced block belong to it, as they are indented under it).
      let end = matchIndex + 1;
      while (end < working.length) {
        const trimmed = working[end].trim();
        if (!trimmed) {
          end += 1;
          continue;
        }
        if (trimmed.startsWith("#") && indentOf(working[end]) > block.keyIndent) {
          end += 1;
          continue;
        }
        if (indentOf(working[end]) <= block.keyIndent) break;
        end += 1;
      }
      const replacement = desired.length === 0
        ? []
        : [`${pad}match:`, ...desired.map(([key, value]) => `${pad}  ${key}: ${value}`)];
      working.splice(matchIndex, end - matchIndex, ...replacement);
    } else if (desired.length > 0) {
      const insertAt = insertionPoint(working, block.keyIndent, []);
      working.splice(insertAt, 0, `${pad}match:`, ...desired.map(([key, value]) => `${pad}  ${key}: ${value}`));
    }
    changed.push("match");
  }

  if (changed.length === 0) return { ok: true, text: raw, changed, lines: {} };

  const head = lines.slice(0, block.start);
  const tail = lines.slice(block.end);
  const joined = [...head, ...working, ...tail].join("\n");
  const nextText = crlf ? joined.replace(/\n/g, "\r\n") : joined;

  const nextBlock = findRuleBlock(nextText, target);
  const lineNumbers: Record<string, number> = {};
  for (const key of changed) {
    const located = nextBlock ? locateKey(nextText, target, key) : null;
    if (located) lineNumbers[key] = located;
  }
  return { ok: true, text: nextText, changed, lines: lineNumbers };
}

/**
 * Where a new key goes: right after `match:`'s block when it exists, otherwise
 * after the last key of the rule — never before the `- name:` line.
 */
function insertionPoint(lines: string[], keyIndent: number, afterBlocks: string[]): number {
  for (const key of afterBlocks) {
    const at = lines.findIndex((line) => indentOf(line) === keyIndent && new RegExp(`^\\s*${key}\\s*:`).test(line));
    if (at < 0) continue;
    let end = at + 1;
    while (end < lines.length) {
      const trimmed = lines[end].trim();
      if (!trimmed || trimmed.startsWith("#")) {
        end += 1;
        continue;
      }
      if (indentOf(lines[end]) <= keyIndent) break;
      end += 1;
    }
    return end;
  }
  let last = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) last = index;
  }
  return last + 1;
}

/** The keys a config error names, longest first, so `match.to` wins over `match`. */
const KEY_HINTS = [
  "match.changedFields", "match.aggregateType", "match.eventType", "match.operator",
  "match.from", "match.to", "match.key", "filter.entityTypes", "filter.events",
  "filter.operator", "filter.linkTypes", "filter.custom", "filter.state",
  "coalesceSec", "maxPerHour", "selfQuietSec", "loopWindowSec", "loopMaxHits",
  "recheck", "inject", "action", "name", "server", "workspace", "match", "filter",
];

/**
 * The line a validator message points at. The message is the one
 * `parseEventsText()` produced (M2's wording, untouched); this only adds the
 * position, and falls back to the rule's own line when the message names
 * nothing locatable.
 */
export function lineForMessage(rawText: string, target: EditTarget, message: string): number | null {
  const text = normalized(rawText).body;
  for (const key of KEY_HINTS) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_.])${key.replace(".", "\\.")}($|[^A-Za-z0-9_])`);
    if (!pattern.test(message)) continue;
    const located = locateKey(text, target, key);
    if (located) return located;
  }
  const block = findRuleBlock(text, target);
  return block ? block.start + 1 : null;
}

/** `<cwd>/.pi/events.yaml` when it exists; the file the panel edits. */
export function eventsConfigPath(cwd: string): string | null {
  for (const relative of EVENTS_CONFIG_RELATIVE_PATHS) {
    const path = join(cwd, relative);
    if (existsSync(path)) return path;
  }
  return null;
}

export interface EditOutcome {
  ok: boolean;
  path: string | null;
  changed: string[];
  /** The validator's message, verbatim, when the edit was refused. */
  error: string | null;
  /** 1-based line of the offending key in the file on disk (unchanged after a refusal). */
  line: number | null;
  /** 1-based line of each rewritten key in the new file. */
  lines: Record<string, number>;
  subscription: EventSubscription | null;
}

/**
 * Applies a patch and writes it, or refuses without touching the file.
 *
 * Order matters: the candidate text is validated first, so a rejected edit
 * leaves the project's file exactly as it was (the panel shows the same message
 * it would get from `/api/events/subscriptions`).
 */
export function saveSubscriptionPatch(
  cwd: string,
  target: EditTarget,
  patch: SubscriptionPatch,
): EditOutcome {
  const path = eventsConfigPath(cwd);
  if (!path) {
    return { ok: false, path: null, changed: [], error: `没有找到 .pi/events.yaml（先在工作台里创建订阅文件）`, line: null, lines: {}, subscription: null };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      path,
      changed: [],
      error: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      line: null,
      lines: {},
      subscription: null,
    };
  }

  const patched = applySubscriptionPatch(text, target, patch);
  if (!patched.ok) return { ok: false, path, changed: [], error: patched.error, line: patched.line, lines: {}, subscription: null };

  const parsed = parseEventsText(patched.text, path);
  const entry = findEntry(parsed, target);
  if (parsed.error) {
    return { ok: false, path, changed: [], error: parsed.error, line: null, lines: {}, subscription: null };
  }
  if (!entry || !entry.subscription) {
    const message = entry?.error ?? `校验后找不到订阅「${target.name}」`;
    return {
      ok: false,
      path,
      changed: [],
      error: message,
      line: lineForMessage(patched.text, target, message),
      lines: {},
      subscription: null,
    };
  }

  if (patched.text !== text) writePrivateFileAtomicSync(path, patched.text);
  return {
    ok: true,
    path,
    changed: patched.changed,
    error: null,
    line: null,
    lines: patched.lines,
    subscription: entry.subscription,
  };
}

function findEntry(config: ReturnType<typeof parseEventsText>, target: EditTarget) {
  const session = config.sessions.find((item) => item.sessionId === target.sessionId);
  if (!session) return null;
  // A broken rule has no `subscription`: its label still names it, which is how
  // the refusal can quote the loader's sentence for *that* rule.
  return session.subscriptions.find((item) =>
    item.subscription?.name === target.name || item.label.includes(`"${target.name}"`),
  ) ?? null;
}

/** The keys the panel may send; anything else is refused before a byte is touched. */
export const PATCH_KEYS = ["action", "coalesceSec", "match"] as const;

/**
 * Request body → patch. Only the three keys the panel exposes; `match` values
 * are normalised to string lists so the closed-set validator — not a second
 * type checker — decides whether a value is acceptable.
 */
export function readPanelPatch(raw: unknown): { patch: SubscriptionPatch } | { error: string } {
  if (raw === undefined) return { patch: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "patch 必须是对象（action / coalesceSec / match）" };
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(PATCH_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return { error: `patch 只接受 ${PATCH_KEYS.join(" / ")}（多出来的是 ${unknown.join("、")}）` };
  }
  const patch: SubscriptionPatch = {};
  if (record.action !== undefined) {
    if (typeof record.action !== "string") {
      return { error: `action 必须是字符串（写的是 ${JSON.stringify(record.action)}）` };
    }
    patch.action = record.action;
  }
  if (record.coalesceSec !== undefined) {
    if (typeof record.coalesceSec !== "number" && typeof record.coalesceSec !== "string") {
      return { error: `coalesceSec 必须是数字或数字字符串（写的是 ${JSON.stringify(record.coalesceSec)}）` };
    }
    patch.coalesceSec = record.coalesceSec;
  }
  if (record.match !== undefined) {
    if (record.match === null) {
      patch.match = null;
    } else if (typeof record.match !== "object" || Array.isArray(record.match)) {
      return { error: "match 必须是对象（eventType / aggregateType / from / to / changedFields / operator）或 null" };
    } else {
      const match: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(record.match as Record<string, unknown>)) {
        if (value === null || value === undefined) {
          match[key] = [];
          continue;
        }
        if (typeof value === "string") {
          match[key] = value.trim() ? [value.trim()] : [];
          continue;
        }
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
          return { error: `match.${key} 只能是数组或字符串（写的是 ${JSON.stringify(value)}）` };
        }
        match[key] = (value as string[]).map((item) => item.trim()).filter(Boolean);
      }
      patch.match = match;
    }
  }
  return { patch };
}

/**
 * A draft of one rule without writing anything: apply the patch to the text,
 * parse the candidate with the real validator, and hand back the rule it
 * describes. Used by the dry run, so a value can be tried before it is saved.
 */
export function draftSubscription(
  cwd: string,
  target: EditTarget,
  patch: SubscriptionPatch,
): { ok: true; subscription: EventSubscription; text: string } | { ok: false; error: string; line: number | null } {
  const path = eventsConfigPath(cwd);
  if (!path) return { ok: false, error: "没有找到 .pi/events.yaml", line: null };
  const text = readFileSync(path, "utf8");
  const patched = applySubscriptionPatch(text, target, patch);
  if (!patched.ok) return { ok: false, error: patched.error, line: patched.line };
  const parsed = parseEventsText(patched.text, path);
  if (parsed.error) return { ok: false, error: parsed.error, line: null };
  const entry = findEntry(parsed, target);
  if (!entry || !entry.subscription) {
    const message = entry?.error ?? `校验后找不到订阅「${target.name}」`;
    return { ok: false, error: message, line: lineForMessage(patched.text, target, message) };
  }
  return { ok: true, subscription: entry.subscription, text: patched.text };
}

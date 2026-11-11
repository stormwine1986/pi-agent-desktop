import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { isPidAlive } from "../scheduled-tasks/lease";

/**
 * Which app process owns the event channel of one `(server, workspace)`.
 *
 * The base server supersedes an older connection with the same `cid` by closing
 * it — and the deployed version sends no `superseded` frame, only the end of the
 * response (verified in `src/domain/extension/sse/sse-hub.ts`: `closeConn`
 * clears the queue, deletes the cid and ends the response). A client cannot tell
 * that close from a network drop, and reconnecting on it would kick the other
 * instance back: two app instances (desktop + dev server) would trade the
 * channel forever.
 *
 * So ownership is decided here, on disk, before a connection is opened:
 *
 * - the later-started live process wins ("后建生效");
 * - the older one, seeing its stream end, finds a newer live owner and stops
 *   ("先建不反抢");
 * - a dead owner's claim is taken over, so a crash does not lock the channel.
 *
 * The cid still goes to the server (`<userId>@<server>`), so two *machines* with
 * the same user are handled by the server's own supersede rule; this file only
 * settles the case the wire protocol leaves ambiguous. It is runtime state, so
 * it lives under `~/.pi/agent`, never in the project.
 */

export interface ChannelClaim {
  pid: number;
  startedAt: string;
}

export type ChannelOwnership =
  | { owner: true }
  | { owner: false; holder: ChannelClaim; reason: string };

function claimPath(dir: string, key: string): string {
  return join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.owner.json`);
}

function readClaim(path: string): ChannelClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChannelClaim>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

/** Process start time, comparable across processes on this machine. */
export function processStartedAt(now: number = Date.now()): string {
  return new Date(now - process.uptime() * 1000).toISOString();
}

export interface ClaimOptions {
  now?: number;
  alive?: (pid: number) => boolean;
  /** This process's start time; defaults to the real one. */
  startedAt?: string;
}

/**
 * Claims the channel for this process, or reports the newer live owner.
 *
 * A claim is written only when this process wins, so the file always names the
 * process a newcomer must compare against.
 */
export function claimChannel(dir: string, key: string, options: ClaimOptions = {}): ChannelOwnership {
  const alive = options.alive ?? isPidAlive;
  const startedAt = options.startedAt ?? processStartedAt(options.now);
  const path = claimPath(dir, key);
  const holder = readClaim(path);

  if (holder && holder.pid !== process.pid) {
    if (alive(holder.pid)) {
      // Same instant (two processes started within the same millisecond) is
      // broken by pid so the verdict is deterministic instead of a coin toss.
      const holderIsNewer = holder.startedAt > startedAt
        || (holder.startedAt === startedAt && holder.pid > process.pid);
      if (holderIsNewer) {
        return {
          owner: false,
          holder,
          reason: `另一实例接管了事件连接（pid ${holder.pid}，启动于 ${holder.startedAt}）`,
        };
      }
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify({ pid: process.pid, startedAt } satisfies ChannelClaim, null, 2)}\n`);
  } catch {
    // An unwritable runtime directory must not disable the feature: the cid still
    // gives the server its own supersede rule.
    return { owner: true };
  }
  return { owner: true };
}

/** Forgets a claim this process owns (used when the runtime stops in a test). */
export function releaseChannel(dir: string, key: string): void {
  const path = claimPath(dir, key);
  if (!existsSync(path)) return;
  const holder = readClaim(path);
  if (holder && holder.pid !== process.pid) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

export function channelClaimPath(dir: string, key: string): string {
  return claimPath(dir, key);
}

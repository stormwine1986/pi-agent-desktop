import { normalizeEnvelope, type EventDescriptor } from "./match";
import type { ChannelOwnership } from "./channel-lease";

/**
 * One SSE connection to a base server's event channel, shared by every
 * subscription in this process that reads the same `(server, workspace)`.
 *
 * Protocol facts this file is built on (SSR-000097【基座现状】, read from the
 * deployed server rather than remembered):
 * - `POST /entity/events/ticket` issues a single-use ticket (201 `{ ticket }`),
 *   because an SSE client cannot send an Authorization header.
 * - `GET /entity/events/stream?ticket=…&workspaceId=…&level=envelope&types=…&entityTypes=…&cid=…`
 *   answers with `text/event-stream`; `Last-Event-ID` replays what was missed and
 *   answers `event: gap` when the window is too short.
 * - `cid` is one connection per user: a newer connection kicks the older one by
 *   *closing* it. The deployed server sends no `superseded` frame, so ownership
 *   is checked out-of-band (`channel-lease.ts`) before every reconnect.
 *
 * Everything here is transport. Matching, batching and delivery live elsewhere.
 */

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "active"
  | "reconnecting"
  | "auth_failed"
  | "superseded"
  | "unavailable";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed attempts (0 while connected). */
  attempt: number;
  /** How long until the next attempt, when `status` is `reconnecting`. */
  nextRetryMs: number | null;
  /** The last failure, in words a panel can print. Never a URL (it carries a ticket). */
  lastError: string | null;
  /** `event: ready`'s connection id, for the status panel. */
  connectionId: string | null;
  /** When a `gap` frame said events were not delivered. */
  gapAt: number | null;
  /** The last successfully seen SSE id, so a reconnect resumes rather than restarts. */
  lastEventId: string | null;
}

export interface EventEndpoint {
  /** `/entity/events/ticket`, derived from the mcp.json entry's url. */
  ticketUrl: string;
  /** `/entity/events/stream`. */
  streamUrl: string;
  /** Headers from mcp.json (Authorization and anything else the entry declares). */
  headers: Record<string, string>;
}

export interface ConnectionDeps {
  fetch: typeof fetch;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** Backoff cap. The spec's number is 60s; tests shrink it. */
  maxBackoffMs: number;
}

const DEFAULT_DEPS: ConnectionDeps = {
  fetch: (...args) => fetch(...args),
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    // Never hold the process open for a retry.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  maxBackoffMs: 60_000,
};

export interface EventConnectionOptions {
  /** `server|workspace`, used for logs and the claim file. */
  key: string;
  serverName: string;
  workspaceId: string;
  endpoint: EventEndpoint;
  /** Coarse server-side filters: the union over every subscription on this channel. */
  types: string[];
  entityTypes: string[];
  /** `<userId>@<server>` — the server's one-connection-per-user key. */
  cid: string;
  lastEventId?: string | null;
  onEvent: (descriptor: EventDescriptor, meta: { id: string | null; workspaceId: string }) => void;
  onState: (state: ConnectionState) => void;
  onGap: (info: { reason?: string; dropped?: number; lastEventId?: string | null }) => void;
  /** Ownership verdict from `claimChannel()`; consulted before every connect. */
  isChannelOwner?: () => ChannelOwnership;
  deps?: Partial<ConnectionDeps>;
}

/** Dedupe ring size: replay after a reconnect can repeat frames. */
const SEEN_CAP = 500;

class AuthError extends Error {}
class RetryableError extends Error {}

/** A URL never reaches a log or a panel: it carries the one-time ticket. */
function safeMessage(error: unknown, serverName: string): string {
  if (error instanceof AuthError) return error.message;
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/ticket=[^&\s]*/gi, "ticket=…")
    .replace(/https?:\/\/[^\s)]+/gi, "…")
    .trim();
  return cleaned ? `${serverName}：${cleaned}` : `${serverName}：连接失败`;
}

export class EventConnection {
  private readonly deps: ConnectionDeps;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private stopped = false;
  private attempt = 0;
  private retryHandle: unknown = null;
  private abort: AbortController | null = null;
  private lastEventId: string | null;
  private state: ConnectionState;

  constructor(private readonly options: EventConnectionOptions) {
    this.deps = { ...DEFAULT_DEPS, ...options.deps };
    this.lastEventId = options.lastEventId ?? null;
    this.state = {
      status: "idle",
      attempt: 0,
      nextRetryMs: null,
      lastError: null,
      connectionId: null,
      gapAt: null,
      lastEventId: this.lastEventId,
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (!this.stopped && this.state.status !== "idle") return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryHandle !== null) {
      this.deps.clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.setState({ status: "idle" });
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }

  /** 1s, 2s, 4s … capped. A `gap` does not reset this; only `ready` does. */
  private backoffMs(): number {
    const exponential = 1_000 * 2 ** Math.max(0, this.attempt - 1);
    return Math.min(exponential, this.deps.maxBackoffMs);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const ownership = this.options.isChannelOwner?.() ?? ({ owner: true } as ChannelOwnership);
      if (!ownership.owner) {
        // Another app process holds the channel. Do not reconnect: the server
        // would close that instance in turn and the two would trade it forever.
        this.setState({ status: "superseded", nextRetryMs: null, lastError: ownership.reason });
        return;
      }

      this.setState({
        status: this.attempt === 0 ? "connecting" : "reconnecting",
        attempt: this.attempt,
        nextRetryMs: null,
        lastError: this.state.lastError,
      });

      try {
        const ticket = await this.requestTicket();
        await this.openStream(ticket);
        // The stream ended without an error: a supersede, a server restart or a
        // proxy timeout. Treated like any other close (ownership is rechecked).
        this.attempt += 1;
      } catch (error) {
        if (error instanceof AuthError) {
          this.setState({ status: "auth_failed", lastError: error.message, nextRetryMs: null });
          return;
        }
        this.attempt += 1;
        this.setState({
          status: "reconnecting",
          attempt: this.attempt,
          // RetryableError is already sanitised and already names the server.
          lastError: error instanceof RetryableError ? error.message : safeMessage(error, this.options.serverName),
        });
      }

      if (this.stopped) return;

      const ownershipAfter = this.options.isChannelOwner?.() ?? ({ owner: true } as ChannelOwnership);
      if (!ownershipAfter.owner) {
        this.setState({ status: "superseded", nextRetryMs: null, lastError: ownershipAfter.reason });
        return;
      }

      const wait = this.backoffMs();
      // The stream is gone: say so while waiting, instead of leaving the panel
      // on "connecting" and making a dropped channel look like a slow start.
      this.setState({ status: "reconnecting", attempt: this.attempt, nextRetryMs: wait });
      await this.delay(wait);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryHandle = this.deps.setTimeout(() => {
        this.retryHandle = null;
        resolve();
      }, ms);
    });
  }

  private async requestTicket(): Promise<string> {
    let response: Response;
    try {
      response = await this.deps.fetch(this.options.endpoint.ticketUrl, {
        method: "POST",
        headers: { ...this.options.endpoint.headers, "content-type": "application/json" },
        body: JSON.stringify({ app: "entity-assistant" }),
      });
    } catch (error) {
      throw new RetryableError(safeMessage(error, this.options.serverName));
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`${this.options.serverName} 拒绝访问（HTTP ${response.status}），检查 mcp.json 里的 Authorization`);
    }
    if (!response.ok) {
      throw new RetryableError(`${this.options.serverName} 申请事件票据失败（HTTP ${response.status}）`);
    }
    const body = (await response.json().catch(() => null)) as { ticket?: unknown } | null;
    const ticket = typeof body?.ticket === "string" ? body.ticket : "";
    if (!ticket) throw new RetryableError(`${this.options.serverName} 没有返回事件票据`);
    return ticket;
  }

  private streamUrl(ticket: string): string {
    const url = new URL(this.options.endpoint.streamUrl);
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("workspaceId", this.options.workspaceId);
    // Envelope only: a subscription needs "something happened"; the text is
    // re-read through the normal tools, so no field value travels here.
    url.searchParams.set("level", "envelope");
    url.searchParams.set("cid", this.options.cid);
    if (this.options.types.length > 0) url.searchParams.set("types", this.options.types.join(","));
    if (this.options.entityTypes.length > 0) url.searchParams.set("entityTypes", this.options.entityTypes.join(","));
    // `coalesce` stays at the server default; it only collapses queue overflow,
    // never a time window, so the client-side coalescing owns that job.
    return url.toString();
  }

  private async openStream(ticket: string): Promise<void> {
    this.abort = new AbortController();
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

    let response: Response;
    try {
      response = await this.deps.fetch(this.streamUrl(ticket), {
        method: "GET",
        headers,
        signal: this.abort.signal,
      });
    } catch (error) {
      if (this.stopped) return;
      throw new RetryableError(safeMessage(error, this.options.serverName));
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`${this.options.serverName} 拒绝了事件流（HTTP ${response.status}）：票据或凭据已失效`);
    }
    if (!response.ok || !response.body) {
      throw new RetryableError(`${this.options.serverName} 的事件流返回 HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.handleFrame(chunk);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (this.stopped) return;
      throw new RetryableError(safeMessage(error, this.options.serverName));
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
      this.abort = null;
    }
  }

  /** One SSE frame: `id:` / `event:` / `data:` lines, comments ignored. */
  private handleFrame(chunk: string): void {
    let event = "";
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") dataLines.push(value);
      // `retry:` is the server's own suggestion; this client owns its backoff.
    }

    if (id) {
      this.lastEventId = id;
      this.setState({ lastEventId: id });
    }
    if (!event && dataLines.length === 0) return;

    if (event === "ready") {
      const data = this.parseData(dataLines);
      const connectionId = typeof data?.connectionId === "string" ? data.connectionId : null;
      this.attempt = 0;
      // The stream is alive and the server accepted this cid: the other
      // instance (if any) has been closed by the server.
      this.setState({ status: "active", attempt: 0, nextRetryMs: null, lastError: null, connectionId });
      return;
    }
    if (event === "gap") {
      const data = this.parseData(dataLines);
      this.setState({ gapAt: this.deps.now() });
      this.options.onGap({
        reason: typeof data?.reason === "string" ? data.reason : undefined,
        dropped: typeof data?.dropped === "number" ? data.dropped : undefined,
        lastEventId: typeof data?.lastEventId === "string" ? data.lastEventId : null,
      });
      return;
    }
    if (event === "bye") return;

    const data = this.parseData(dataLines);
    if (!data) return;
    const descriptor = normalizeEnvelope(data);
    if (!descriptor) return;

    // Replay after a reconnect repeats frames; the ring is per connection.
    if (descriptor.eventId) {
      if (this.seen.has(descriptor.eventId)) return;
      this.seen.add(descriptor.eventId);
      this.seenOrder.push(descriptor.eventId);
      if (this.seenOrder.length > SEEN_CAP) {
        const oldest = this.seenOrder.shift();
        if (oldest) this.seen.delete(oldest);
      }
    }

    this.options.onEvent(descriptor, {
      id,
      workspaceId: typeof data.workspaceId === "string" ? data.workspaceId : this.options.workspaceId,
    });
  }

  private parseData(lines: string[]): Record<string, unknown> | null {
    if (lines.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(lines.join("\n"));
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

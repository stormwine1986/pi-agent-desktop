/**
 * Minimal `text/event-stream` reader, per the WHATWG HTML event-stream format:
 * fields separated by `:` up to the first newline, one event per blank line,
 * a leading `:` line is a comment (heartbeat), and an event without a `data`
 * field is not dispatched.
 *
 * The app's own SSE endpoints are written server-side, so this is the first
 * place that has to *parse* the format — keeping it a pure function makes the
 * probe route testable without a network.
 */
export interface SseEvent {
  id: string | null;
  event: string | null;
  data: string;
}

export interface SseParseResult {
  events: SseEvent[];
  /** Bytes after the last blank line: an event still arriving. */
  rest: string;
}

export function parseSseEvents(buffer: string): SseParseResult {
  // CRLF and bare CR are both valid line endings in the spec.
  const blocks = buffer.replace(/\r\n?/g, "\n").split("\n\n");
  // Whatever follows the final separator is incomplete by definition.
  const rest = blocks.pop() ?? "";
  const events: SseEvent[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines: string[] = [];
    let id: string | null = null;
    let event: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
      else if (field === "event") event = value;
      // `retry` and unknown fields carry no payload worth showing.
    }
    // An event with no data field never reaches the EventSource listener.
    if (dataLines.length === 0) continue;
    events.push({ id, event, data: dataLines.join("\n") });
  }

  return { events, rest };
}

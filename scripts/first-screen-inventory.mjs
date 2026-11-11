// Turn a cold start's probe logs into the first-screen request inventory
// (TASK-000113).
//
// Input is a run with `PI_FIRST_SCREEN_PROBE=1` (server.log carries a
// `[probe] #n METHOD /path start|done` line per request and a `[probe] stall Nms
// …` line per event-loop gap ≥50 ms) and the shell's desktop.log (`main window
// revealed`). Output lists every request answered *before* that reveal, with its
// TTFB and the largest stall it was in flight for, plus the requests before the
// first byte of the page for comparison.
//
// usage:
//   node scripts/first-screen-inventory.mjs <server.log> <desktop.log> [--json]
//
// The inventory itself, its routes and the reasoning live in
// docs/agents/first-screen-requests.md; this script only re-derives the numbers
// from a log pair, so a claim in that document can be checked against a run.
import { readFileSync } from "node:fs";

const [, , serverLogPath, desktopLogPath, ...flags] = process.argv;
if (!serverLogPath || !desktopLogPath) {
  console.error("usage: node scripts/first-screen-inventory.mjs <server.log> <desktop.log> [--json]");
  process.exit(2);
}
const asJson = flags.includes("--json");

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/;
const PROBE_START = /^\[probe\] #(\d+) ([A-Z]+) (\S+) start \+(\d+)ms inflight (\d+)$/;
const PROBE_DONE = /^\[probe\] #(\d+) ([A-Z]+) (\S+) done \+(\d+)ms dur (\d+)ms status (\d+) inflight (\d+)$/;
const PROBE_STALL = /^\[probe\] stall (\d+)ms ending \+(\d+)ms during (.*)$/;

function readLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = ISO.exec(line);
    return match ? [{ at: Date.parse(match[1]), text: match[2] }] : [];
  });
}

const desktop = readLines(desktopLogPath);
const reveal = desktop.filter((line) => line.text.startsWith("main window revealed")).at(-1);
if (!reveal) {
  console.error(`${desktopLogPath}: no "main window revealed" line`);
  process.exit(1);
}
const revealAt = reveal.at;

// One server.log holds several cold starts (the probe counter restarts with each
// process), so take the run whose launcher opened last before the reveal.
const allServerLines = readLines(serverLogPath);
const runStarts = allServerLines.filter((line) => line.text.includes("launcher started"));
const runStart = runStarts.filter((line) => line.at <= revealAt).at(-1);
if (!runStart) {
  console.error(`${serverLogPath}: no launcher start before the reveal`);
  process.exit(1);
}
const server = allServerLines.filter((line) => line.at >= runStart.at && line.at <= revealAt);
const startedAt = runStart.at;

/** Requests and stalls in server order. */
const requests = [];
const stalls = [];
for (const line of server) {
  const start = PROBE_START.exec(line.text);
  if (start) {
    requests.push({ id: Number(start[1]), method: start[2], path: start[3], startedAt: line.at, order: requests.length });
    continue;
  }
  const done = PROBE_DONE.exec(line.text);
  if (done) {
    const request = requests.find((candidate) => candidate.id === Number(done[1]) && candidate.doneAt === undefined);
    if (request) {
      request.doneAt = line.at;
      request.durationMs = Number(done[5]);
      request.status = Number(done[6]);
    }
    continue;
  }
  const stall = PROBE_STALL.exec(line.text);
  if (stall) {
    stalls.push({ durationMs: Number(stall[1]), endedAt: line.at, startedAt: line.at - Number(stall[1]), during: stall[3] });
  }
}

const before = requests.filter((request) => (
  request.startedAt <= revealAt
  && !request.path.startsWith("/_next/")
  && !request.path.startsWith("/icons/")
));
const rows = before.map((request) => {
  // A stall belongs to a request when it ended while that request was in flight
  // (the loop was held during its work) — the probe's own attribution.
  // Overlap, not containment: a stall that begins just before the handler and
  // ends inside its window is still the reason its response was late.
  const own = stalls.filter((stall) => stall.startedAt <= (request.doneAt ?? revealAt) && stall.endedAt >= request.startedAt);
  const maxStall = own.reduce((max, stall) => Math.max(max, stall.durationMs), 0);
  return {
    id: request.id,
    atMs: request.startedAt - startedAt,
    latestDoneMs: request.doneAt ? request.doneAt - startedAt : null,
    method: request.method,
    path: request.path,
    status: request.status ?? null,
    ttfbMs: request.durationMs ?? null,
    maxStallMs: maxStall,
  };
});

const revealOffsetMs = revealAt - startedAt;
const pageFirstByte = rows.find((row) => row.path === "/")?.ttfbMs ?? null;
const slowest = rows.filter((row) => (row.ttfbMs ?? 0) >= 300 || row.maxStallMs >= 300);

if (asJson) {
  console.log(JSON.stringify({ revealOffsetMs, pageFirstByte, requests: rows, slowest }, null, 2));
} else {
  console.log(`cold start: ${rows.length} non-asset requests before "main window revealed" (at +${revealOffsetMs} ms)`);
  console.log(`page (GET /) TTFB: ${pageFirstByte ?? "-"} ms`);
  console.log("");
  const width = Math.max(...rows.map((row) => row.path.length));
  console.log(`${"#".padStart(3)}  ${"+ms".padStart(6)}  ${"path".padEnd(width)}  ${"status".padStart(6)}  ${"TTFB".padStart(7)}  ${"max stall".padStart(9)}`);
  for (const row of rows) {
    console.log(
      `${String(row.id).padStart(3)}  ${String(row.atMs).padStart(6)}  ${row.path.padEnd(width)}  ${String(row.status ?? "-").padStart(6)}  ${String(row.ttfbMs ?? "-").padStart(7)}  ${String(row.maxStallMs).padStart(9)}`,
    );
  }
  console.log("");
  console.log(slowest.length === 0
    ? "no request before app_ready paid ≥300 ms (TTFB or in-flight stall)"
    : `≥300 ms before app_ready:\n${slowest.map((row) => `  #${row.id} ${row.path}: TTFB ${row.ttfbMs ?? "-"} ms, max stall ${row.maxStallMs} ms`).join("\n")}`);
}

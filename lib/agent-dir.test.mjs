import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { agentDir } from "./agent-dir.ts";

// The startup path (instrumentation) resolves the agent directory without the
// pi SDK; every other code path gets it from `getAgentDir()`. They must agree,
// or the scheduler, the watch pump and the event runtime would read and write a
// different directory than the rest of the app (TASK-000108).
const sdk = await import("@earendil-works/pi-coding-agent");

/** Run `body` with exactly the given pi path env, then put the environment back. */
function withEnv(env, body) {
  const keys = ["PI_CODING_AGENT_DIR", "PI_AGENT_HOME"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return body();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("resolves the same agent directory as the pi SDK", () => {
  const configured = {
    unset: undefined,
    absolute: process.platform === "win32" ? "D:\\pi-agent-data" : "/tmp/pi-agent-data",
    tilde: "~",
    nestedTilde: "~/project-agent",
    relative: "relative-agent",
    fileUrl: pathToFileURL(join(homedir(), "from-url")).href,
    // pi converts Git Bash / MSYS drive paths to a native Windows path.
    shellDrive: process.platform === "win32" ? "/d/pi-agent-data" : "/d/pi-agent-data",
    ...(process.platform === "win32" ? { shellDriveBare: "/d" } : {}),
  };
  for (const [label, value] of Object.entries(configured)) {
    const env = value === undefined ? {} : { PI_CODING_AGENT_DIR: value };
    const ours = withEnv(env, () => agentDir());
    const theirs = withEnv(env, () => sdk.getAgentDir());
    assert.equal(ours, theirs, `PI_CODING_AGENT_DIR=${label}`);
  }
});

test("falls back to <home>/.pi/agent when nothing is configured", () => {
  assert.equal(withEnv({}, () => agentDir()), join(homedir(), ".pi", "agent"));
});

test("PI_AGENT_HOME moves the directory, as it does for every other pi path", () => {
  // Deliberate fork behaviour (lib/user-home.ts): the one case where this
  // helper and pi's getAgentDir() differ. Nothing packaged sets it.
  const home = join(homedir(), "pi-agent-home");
  const withHome = (env) => withEnv({ ...env, PI_AGENT_HOME: home }, () => agentDir());
  assert.equal(withHome({}), join(home, ".pi", "agent"));
  assert.equal(withHome({ PI_CODING_AGENT_DIR: "~/inside" }), join(home, "inside"));
});

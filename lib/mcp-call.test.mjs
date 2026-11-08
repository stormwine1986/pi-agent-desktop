import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveMcpTarget } = await jiti.import("./mcp-call.ts");

/** An agent dir plus a project dir, each optionally holding an `mcp.json`. */
function fixture({ global, project }) {
  const root = mkdtempSync(join(tmpdir(), "mcp-call-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (global) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: global }));
  if (project) writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: project }));
  return { root, agentDir, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const server = (url) => ({ type: "http", url, headers: { Authorization: "Bearer t" } });

test("a name pi rewrote for its namespace still finds the configured server", () => {
  // The conversation saw `mcp__entity_demo_system_evan__list`, so that is the
  // server name a reply copies into an `entity-item:` link — while mcp.json
  // names the entry `entity-demo-system-evan`. Rejecting the link made the
  // panel look broken for every dashed server name.
  const fx = fixture({ project: { "entity-demo-system-evan": server("http://10.8.0.125:3100/entity/mcp") } });
  try {
    const resolved = resolveMcpTarget(fx.agentDir, fx.cwd, "entity_demo_system_evan");
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
    assert.equal(resolved.target.url, "http://10.8.0.125:3100/entity/mcp");
    // The configured spelling comes back, so follow-up requests name the real entry.
    assert.equal(resolved.target.name, "entity-demo-system-evan");
    assert.equal(resolved.target.headers.Authorization, "Bearer t");
  } finally {
    fx.cleanup();
  }
});

test("an exact name still wins over a namespace twin", () => {
  const fx = fixture({
    project: {
      "a-b": server("http://exact.invalid/mcp"),
      "a_b": server("http://twin.invalid/mcp"),
    },
  });
  try {
    assert.equal(resolveMcpTarget(fx.agentDir, fx.cwd, "a_b").target.url, "http://twin.invalid/mcp");
    assert.equal(resolveMcpTarget(fx.agentDir, fx.cwd, "a-b").target.url, "http://exact.invalid/mcp");
  } finally {
    fx.cleanup();
  }
});

test("the project file is matched before the global one, aliases included", () => {
  const fx = fixture({
    global: { "entity-base": server("http://global.invalid/mcp") },
    project: { "entity_base": server("http://project.invalid/mcp") },
  });
  try {
    assert.equal(resolveMcpTarget(fx.agentDir, fx.cwd, "entity-base").target.url, "http://project.invalid/mcp");
  } finally {
    fx.cleanup();
  }
});

test("a name no entry answers to keeps the old error and the configured list", () => {
  const fx = fixture({ project: { "entity-demo-system-evan": server("http://10.8.0.125:3100/entity/mcp") } });
  try {
    const resolved = resolveMcpTarget(fx.agentDir, fx.cwd, "nobody");
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /没有名为 "nobody" 的 server/);
    assert.match(resolved.error, /entity-demo-system-evan/);
  } finally {
    fx.cleanup();
  }
});

test("a resolved alias is still refused when it is not an HTTP endpoint", () => {
  const fx = fixture({ project: { "some-server": { command: "npx", args: ["-y", "srv"] } } });
  try {
    const resolved = resolveMcpTarget(fx.agentDir, fx.cwd, "some_server");
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /stdio/);
  } finally {
    fx.cleanup();
  }
});

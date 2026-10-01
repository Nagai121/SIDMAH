import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { InMemoryProvider, SidmahSystem } from "../src/index.ts";
import { applyMcpConfig, checkMcpConfig } from "../src/maintenance/mcp-config-sync.ts";

const runtimeRoot = resolve(import.meta.dirname, "..");
const serverPath = resolve(runtimeRoot, "src", "mcp", "server.ts");

function runServer(root: string, requests: unknown[]) {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.SIDMAH_PROVIDER_SESSION_ID; delete env.SIDMAH_SESSION_TOKEN; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", serverPath, root], {
    input: requests.map(x => JSON.stringify(x)).join("\n") + "\n",
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test("MCP initialize and tools/list succeed without startup session identity", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v41-mcp-"));
  try {
    const rows = runServer(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    assert.equal(rows[0].result.serverInfo.version, JSON.parse(readFileSync(resolve(runtimeRoot, "package.json"), "utf8")).version);
    assert.ok(rows[1].result.tools.some((tool: any) => tool.name === "director_start"));
    assert.ok(rows[1].result.tools.some((tool: any) => tool.name === "starter"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing caller identity rejects only the tool call and MCP process stays alive", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v41-soft-fail-"));
  try {
    const rows = runServer(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "director_start", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
    ]);
    assert.equal(rows[1].error.data.code, "SESSION_CONTEXT_REQUIRED");
    assert.deepEqual(rows[2].result, {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("director_start works from Codex _meta.threadId without startup environment identity", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v41-meta-call-"));
  try {
    const rows = runServer(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "director_start", arguments: {}, _meta: { threadId: "codex-thread-v41" } } },
      { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
    ]);
    assert.ok(rows[1].result.structuredContent.runId);
    assert.deepEqual(rows[2].result, {});
    const db = new DatabaseSync(resolve(root, "state", "cell_management.sqlite"), { readOnly: true });
    try { assert.equal((db.prepare("SELECT provider_session_id FROM director_runs WHERE status='active'").get() as any).provider_session_id, "codex-thread-v41"); } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex tools/call _meta.threadId becomes provider identity and resolves internal session tokens", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v41-thread-"));
  writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "test-worker" }), "utf8");
  const provider = new InMemoryProvider(), system = new SidmahSystem(root, provider);
  try {
    const directorContext = system.contextForProviderSession("thread-director", true);
    system.startDirector(directorContext);
    assert.equal(system.contextForProviderSession("thread-director").sessionToken, directorContext.sessionToken);
    await system.createCell(system.contextForProviderSession("thread-director"), { responsibility: "test" });
    const workerProviderId = "thread-worker";
    await system.acceptCell({ providerSessionId: workerProviderId, sessionToken: "unregistered" }, true);
    const workerToken = (system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id=?").get(workerProviderId) as any).session_token;
    assert.equal(system.contextForProviderSession(workerProviderId).sessionToken, workerToken);
  } finally { system.close(); rmSync(root, { recursive: true, force: true }); }
});

test("MCP config sync replaces only sidmah global entry and points it at the current harness root", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v41-config root-"));
  const configPath = resolve(root, "user-config.toml");
  try {
    writeFileSync(resolve(root, "mcp-config.json"), JSON.stringify({ serverName: "sidmah", command: "node", nodeArgs: ["--experimental-strip-types"], enabled: true, required: false, startupTimeoutSec: 30, toolTimeoutSec: 300 }), "utf8");
    writeFileSync(configPath, `[model]\nname = "keep-me"\n\n[mcp_servers.sidmah]\ncommand = "node"\nargs = ["old/server.ts", "C:/old/root"]\nenabled = true\nrequired = true\n\n[mcp_servers.other]\ncommand = "other"\n`, "utf8");
    assert.equal(checkMcpConfig(root, configPath).synced, false);
    assert.equal(applyMcpConfig(root, configPath).synced, true);
    const text = readFileSync(configPath, "utf8");
    assert.match(text, /name = "keep-me"/);
    assert.match(text, /\[mcp_servers\.other\]/);
    assert.match(text, /required = false/);
    assert.match(text, new RegExp(resolve(root).replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /C:\/old\/root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  applyAllMcpConfigs, applyMcpConfig, applyOpenCodeConfig,
  checkAllMcpConfigs, checkMcpConfig, checkOpenCodeConfig,
  codexConfigPath, openCodeConfigPath, expectedSidmahBlock, expectedOpenCodeEntry,
} from "../src/maintenance/mcp-config-sync.ts";

const config = {
  serverName: "sidmah", command: "node", nodeArgs: ["--experimental-strip-types"],
  enabled: true, required: false, startupTimeoutSec: 30, toolTimeoutSec: 300,
};

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah portable workspace-"));
  writeFileSync(resolve(root, "mcp-config.json"), JSON.stringify(config), "utf8");
  return root;
}

test("MCP settings are project-local and require no absolute SIDMAH path", () => {
  const root = fixture();
  try {
    assert.equal(codexConfigPath(root), resolve(root, ".codex", "config.toml"));
    assert.equal(openCodeConfigPath(root), resolve(root, "opencode.json"));
    assert.equal(checkAllMcpConfigs(root).synced, false);
    assert.equal(applyAllMcpConfigs(root).synced, true);
    const codex = readFileSync(codexConfigPath(root), "utf8");
    const open = readFileSync(openCodeConfigPath(root), "utf8");
    assert.ok(codex.includes('cwd = "."'));
    assert.ok(codex.includes('"sidmah_runtime/src/mcp/server.ts"'));
    assert.ok(!codex.includes(root));
    assert.ok(!open.includes(root));
    assert.deepEqual(JSON.parse(open).mcp.sidmah, expectedOpenCodeEntry(root));
    assert.equal(checkMcpConfig(root).synced, true);
    assert.equal(checkOpenCodeConfig(root).synced, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("copying the same SIDMAH configuration to a different root does not require rewriting either MCP entry", () => {
  const first = fixture(), second = fixture();
  try {
    assert.equal(expectedSidmahBlock(first), expectedSidmahBlock(second));
    assert.deepEqual(expectedOpenCodeEntry(first), expectedOpenCodeEntry(second));
    applyAllMcpConfigs(first);
    mkdirSync(resolve(second, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(second), readFileSync(codexConfigPath(first), "utf8"));
    writeFileSync(openCodeConfigPath(second), readFileSync(openCodeConfigPath(first), "utf8"));
    assert.equal(checkAllMcpConfigs(second).synced, true);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("Codex and OpenCode sync preserve other user configuration entries", () => {
  const root = fixture();
  try {
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(root),
      '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.sidmah]\ncommand = "wrong"\n', "utf8");
    writeFileSync(openCodeConfigPath(root), JSON.stringify({
      theme: "keep-me", mcp: {
        other: { type: "local", command: ["other"] },
        sidmah: { type: "local", command: ["old"] },
      },
    }), "utf8");
    applyMcpConfig(root);
    applyOpenCodeConfig(root);
    assert.match(readFileSync(codexConfigPath(root), "utf8"), /mcp_servers.other/);
    const opencode = JSON.parse(readFileSync(openCodeConfigPath(root), "utf8"));
    assert.equal(opencode.theme, "keep-me");
    assert.deepEqual(opencode.mcp.other.command, ["other"]);
    assert.equal(checkAllMcpConfigs(root).synced, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid OpenCode config is rejected without modifying existing Codex config", () => {
  const root = fixture();
  try {
    mkdirSync(resolve(root, ".codex"), { recursive: true });
    const original = '[mcp_servers.other]\ncommand = "unchanged"\n';
    writeFileSync(codexConfigPath(root), original);
    writeFileSync(openCodeConfigPath(root), '{"mcp": [], "theme": "broken"}');
    assert.throws(() => applyAllMcpConfigs(root), /opencode.json mcp must be an object/);
    assert.equal(readFileSync(codexConfigPath(root), "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("MCP server resolves project root from cwd when no root argument is given", () => {
  const root = fixture();
  const server = resolve(import.meta.dirname, "..", "src", "mcp", "server.ts");
  try {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "director_start", arguments: {}, _meta: { threadId: "portable-cwd-director" },
      } },
    ];
    const run = spawnSync(process.execPath, ["--experimental-strip-types", server], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      input: requests.map(value => JSON.stringify(value)).join("\n") + "\n",
    });
    assert.equal(run.status, 0, run.stderr);
    const response = run.stdout.trim().split(/\r?\n/).map(value => JSON.parse(value));
    assert.ok(response[1].result.structuredContent.runId);
    assert.ok(existsSync(resolve(root, "state", "cell_management.sqlite")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

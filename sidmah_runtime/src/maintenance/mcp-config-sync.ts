import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export type HarnessMcpConfig = {
  serverName: string;
  command: string;
  nodeArgs: string[];
  enabled: boolean;
  required: boolean;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
};

const tomlString = (value: string): string => JSON.stringify(value.replace(/\\/g, "/"));
const sectionName = (line: string): string | undefined => {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
  return match?.[1]?.trim();
};
const normalizedSection = (section: string): string => section.replace(/"/g, "").replace(/'/g, "");

export function codexConfigPath(root = process.cwd()): string {
  return process.env.SIDMAH_CODEX_CONFIG ?? resolve(root, ".codex", "config.toml");
}

export function loadHarnessConfig(root: string): HarnessMcpConfig {
  const value = JSON.parse(readFileSync(resolve(root, "mcp-config.json"), "utf8"));
  if (value?.serverName !== "sidmah" || typeof value.command !== "string" || !Array.isArray(value.nodeArgs)) throw new Error("mcp-config.json is invalid");
  return value as HarnessMcpConfig;
}

export function expectedSidmahBlock(root: string, config = loadHarnessConfig(root)): string {
  const args = [...config.nodeArgs, "sidmah_runtime/src/mcp/server.ts"];
  return [
    `[mcp_servers.${config.serverName}]`,
    `command = ${tomlString(config.command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `cwd = "."`,
    `enabled = ${config.enabled ? "true" : "false"}`,
    `required = ${config.required ? "true" : "false"}`,
    `startup_timeout_sec = ${Number(config.startupTimeoutSec)}`,
    `tool_timeout_sec = ${Number(config.toolTimeoutSec)}`,
  ].join("\n");
}

export function replaceSidmahConfig(source: string, block: string, serverName = "sidmah"): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false, inserted = false;
  const prefix = `mcp_servers.${serverName}`;
  for (const line of lines) {
    const section = sectionName(line);
    if (section !== undefined) {
      const normalized = normalizedSection(section);
      const target = normalized === prefix || normalized.startsWith(`${prefix}.`);
      if (target) {
        if (!inserted) { if (out.length && out[out.length - 1] !== "") out.push(""); out.push(block); inserted = true; }
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  if (!inserted) {
    while (out.length && out[out.length - 1] === "") out.pop();
    if (out.length) out.push("");
    out.push(block, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function checkMcpConfig(root: string, path = codexConfigPath(root)) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const expectedBlock = expectedSidmahBlock(root);
  const expectedFile = replaceSidmahConfig(current, expectedBlock);
  const normalize = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
  return { synced: normalize(current) === normalize(expectedFile), path, root: resolve(root), expectedBlock };
}

export function applyMcpConfig(root: string, path = codexConfigPath(root)) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = replaceSidmahConfig(current, expectedSidmahBlock(root));
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.sidmah-${process.pid}.tmp`;
  writeFileSync(temp, next, "utf8");
  renameSync(temp, path);
  return checkMcpConfig(root, path);
}


/**
 * OpenCode stores MCP server definitions in project-local opencode.json.
 * Preserve all unrelated settings and other MCP servers.
 */
export function openCodeConfigPath(root: string): string {
  return resolve(root, "opencode.json");
}

export function expectedOpenCodeEntry(root: string, config = loadHarnessConfig(root)) {
  return {
    type: "local",
    command: [config.command, ...config.nodeArgs, "sidmah_runtime/src/mcp/server.ts"],
    cwd: ".",
    enabled: config.enabled,
    timeout: config.startupTimeoutSec * 1000,
  };
}

function readOpenCodeConfig(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("opencode.json must be an object");
  const value = parsed as Record<string, any>;
  if (value.mcp !== undefined && (!value.mcp || typeof value.mcp !== "object" || Array.isArray(value.mcp))) {
    throw new Error("opencode.json mcp must be an object");
  }
  return value;
}

export function checkOpenCodeConfig(root: string, path = openCodeConfigPath(root)) {
  const existing = readOpenCodeConfig(path).mcp?.sidmah;
  const expected = expectedOpenCodeEntry(root);
  const synced = isDeepStrictEqual(existing, expected);
  return { synced, path, root: resolve(root), expected };
}

export function applyOpenCodeConfig(root: string, path = openCodeConfigPath(root)) {
  const old = readOpenCodeConfig(path);
  const next = {
    ...old,
    ...(old.$schema === undefined ? { $schema: "https://opencode.ai/config.json" } : {}),
    mcp: { ...(old.mcp ?? {}), sidmah: expectedOpenCodeEntry(root) },
  };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.sidmah-${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(temp, path);
  return checkOpenCodeConfig(root, path);
}

export function checkAllMcpConfigs(root: string) {
  const codex = checkMcpConfig(root);
  const opencode = checkOpenCodeConfig(root);
  return { synced: codex.synced && opencode.synced, root: resolve(root), codex, opencode };
}

export function applyAllMcpConfigs(root: string) {
  // Validate both inputs before changing either configuration.
  loadHarnessConfig(root);
  readOpenCodeConfig(openCodeConfigPath(root));
  applyMcpConfig(root);
  applyOpenCodeConfig(root);
  return checkAllMcpConfigs(root);
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? ".");
  const mode = process.argv[3] ?? "check";
  if (mode === "check" || mode === "preflight") { console.log(JSON.stringify(checkAllMcpConfigs(root), null, 2)); return; }
  if (mode === "apply") { console.log(JSON.stringify(applyAllMcpConfigs(root), null, 2)); return; }
  throw new Error("Usage: mcp-config-sync.ts <sidmah-root> <check|apply|preflight>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

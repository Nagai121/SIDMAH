// Snapshot inspection, read-only preflight and integrity utilities.
// Independent of Cell / Worker / Binding / inbox state.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { invariant } from "../core/errors.ts";
import { json } from "../core/db.ts";

export function validateExperiment(snapshot: string): void {
  const path = resolve(snapshot, "experiment.json");
  invariant(existsSync(path), "EXPERIMENT_MISSING", "Work Place must contain experiment.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  invariant(value && typeof value === "object" && Object.keys(value).sort().join("|") === "finisher|simulator|starter", "EXPERIMENT_INVALID", "experiment.json must contain exactly starter, simulator, finisher");
  for (const name of ["starter", "simulator", "finisher"]) {
    const command = value[name];
    invariant(Array.isArray(command) && command.length > 0 && command.every((x: unknown) => typeof x === "string" && x.length > 0), "EXPERIMENT_INVALID", `${name} must be a non-empty command array`);
    invariant(command.slice(1).every((x: string) => !isAbsolute(x) && !x.split(/[\\/]/).includes("..")), "SNAPSHOT_ESCAPE", `${name} arguments may not escape Snapshot`);
  }
}

export function freezeSnapshot(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) freezeSnapshot(resolve(path, name));
  }
  try { chmodSync(path, stat.mode & ~0o222); } catch {}
}

export function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) for (const name of readdirSync(path)) makeWritable(resolve(path, name));
  try { chmodSync(path, stat.mode | 0o200); } catch {}
}

export function removeSnapshot(path: string): void {
  makeWritable(path);
  rmSync(path, { recursive: true, force: true });
}

export function treeManifest(root: string): { hash: string; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      entries.push({ path: relative || ".", type: "directory", mode: stat.mode, size: stat.size });
      for (const name of readdirSync(path).sort()) visit(resolve(path, name), relative ? `${relative}/${name}` : name);
    } else {
      const body = readFileSync(path);
      entries.push({ path: relative, type: "file", mode: stat.mode, size: stat.size, sha256: createHash("sha256").update(body).digest("hex") });
    }
  };
  visit(root, "");
  return { hash: createHash("sha256").update(json(entries)).digest("hex"), entries };
}

export function aclSummary(path: string): Record<string, unknown> {
  if (process.platform !== "win32") return { platform: process.platform, available: false };
  try {
    const result = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    return { platform: "win32", available: result.status === 0, status: result.status, stdout: result.stdout?.slice(0, 16_384), stderr: result.stderr?.slice(0, 4_096) };
  } catch (error) { return { platform: "win32", available: false, error: String(error) }; }
}

export function classifySnapshotFailure(error: any, source: string, destination: string): string {
  if (existsSync(destination)) return "destination_exists";
  if (!existsSync(source)) return "invalid_source_tree";
  if (["EACCES", "EROFS"].includes(error?.code)) return "access_or_acl";
  if (["EBUSY", "ENOTEMPTY"].includes(error?.code)) return "transient_lock";
  if (error?.code === "EPERM") return process.platform === "win32" ? "unknown_windows_lock" : "access_or_acl";
  return "unknown";
}

export async function runStarterPreflight(workPlace: string, runtimeDir: string, timeoutMs: number): Promise<void> {
  const preflight = resolve(runtimeDir, `.preflight-${randomUUID()}`);
  const preflightOutput = resolve(runtimeDir, `.preflight-output-${randomUUID()}`);
  try {
    cpSync(workPlace, preflight, { recursive: true, errorOnExist: true });
    mkdirSync(preflightOutput, { recursive: true });
    validateExperiment(preflight);
    freezeSnapshot(preflight);
    const before = treeManifest(preflight).hash;
    const contract = JSON.parse(readFileSync(resolve(preflight, "experiment.json"), "utf8"));
    const [command, ...args] = contract.starter as string[];
    const result = spawnSync(command, args, {
      cwd: preflight, encoding: "utf8", windowsHide: true, timeout: timeoutMs,
      env: { ...process.env, SIDMAH_PREFLIGHT: "1", SIDMAH_SNAPSHOT: preflight, SIDMAH_RUNTIME_OUTPUT: preflightOutput },
    });
    const after = treeManifest(preflight).hash;
    invariant(result.status === 0 && !result.error, "STARTER_PREFLIGHT_FAILED", `Starter preflight failed: ${result.error ?? result.stderr ?? `exit ${result.status}`}`);
    invariant(before === after, "STARTER_PREFLIGHT_MUTATED", "Starter modified the read-only preflight Snapshot");
  } finally {
    removeSnapshot(preflight);
    rmSync(preflightOutput, { recursive: true, force: true });
  }
}

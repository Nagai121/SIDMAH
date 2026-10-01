import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface StageResult { state: "success" | "failed" | "timeout" | "skipped"; exitCode: number | null; signal: string | null; stdout: string; stderr: string }

async function command(command: string[], cwd: string, runtimeDirectory: string, remainingMs: number | undefined): Promise<StageResult> {
  if (remainingMs !== undefined && remainingMs <= 0) return { state: "timeout", exitCode: null, signal: null, stdout: "", stderr: "Runtime timeout before stage" };
  return await new Promise(resolvePromise => {
    const child = spawn(command[0], command.slice(1), { cwd, windowsHide: true, shell: false, env: { ...process.env, SIDMAH_SNAPSHOT: cwd, SIDMAH_RUNTIME_OUTPUT: runtimeDirectory } });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout?.on("data", data => stdout += data.toString());
    child.stderr?.on("data", data => stderr += data.toString());
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (remainingMs !== undefined) {
      const deadline = Date.now() + remainingMs;
      const checkTimeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { timedOut = true; child.kill("SIGKILL"); }
        else timer = setTimeout(checkTimeout, Math.min(remaining, 2_147_483_647));
      };
      checkTimeout();
    }
    child.on("error", error => { clearTimeout(timer); resolvePromise({ state: "failed", exitCode: null, signal: null, stdout, stderr: stderr + String(error) }); });
    child.on("exit", (code, signal) => { clearTimeout(timer); resolvePromise({ state: timedOut ? "timeout" : code === 0 ? "success" : "failed", exitCode: code, signal, stdout, stderr }); });
  });
}

export async function executePipeline(snapshot: string, runtimeDirectory: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const contract = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(snapshot, "experiment.json"), "utf8"));
  const started = Date.now(), results: Record<string, StageResult> = {};
  const remaining = () => timeoutMs === 0 ? undefined : timeoutMs - (Date.now() - started);
  const skipped = (): StageResult => ({ state: "skipped", exitCode: null, signal: null, stdout: "", stderr: "" });
  results.starter = await command(contract.starter, snapshot, runtimeDirectory, remaining());
  if (results.starter.state !== "success") { results.simulator = skipped(); results.finisher = skipped(); }
  else {
    results.simulator = await command(contract.simulator, snapshot, runtimeDirectory, remaining());
    results.finisher = results.simulator.state === "timeout" ? skipped() : await command(contract.finisher, snapshot, runtimeDirectory, remaining());
  }
  mkdirSync(runtimeDirectory, { recursive: true });
  for (const [name, value] of Object.entries(results)) {
    writeFileSync(resolve(runtimeDirectory, `${name}.stdout.log`), value.stdout, "utf8");
    writeFileSync(resolve(runtimeDirectory, `${name}.stderr.log`), value.stderr, "utf8");
  }
  const status = results.starter.state !== "success" ? (results.starter.state === "timeout" ? "timeout" : "starter_failed")
    : results.simulator.state === "timeout" ? "timeout"
    : results.finisher.state === "timeout" ? "timeout"
    : results.finisher.state !== "success" ? "finisher_failed"
    : results.simulator.state !== "success" ? "simulator_failed" : "success";
  return { schemaVersion: 1, executionStatus: status, startedAt: started, finishedAt: Date.now(), stages: results };
}

export function writeFixedResult(runtimeDirectory: string, runtimeId: string, result: unknown): { resultRef: string; resultHash: string; manifestRef: string } {
  mkdirSync(runtimeDirectory, { recursive: true });
  const body = JSON.stringify(result, null, 2), hash = createHash("sha256").update(body).digest("hex");
  const resultRef = resolve(runtimeDirectory, "result.json"), manifestRef = resolve(runtimeDirectory, "result.manifest.json");
  const resultTmp = `${resultRef}.${randomUUID()}.tmp`, manifestTmp = `${manifestRef}.${randomUUID()}.tmp`;
  writeFileSync(resultTmp, body, "utf8");
  writeFileSync(manifestTmp, JSON.stringify({ schemaVersion: 1, runtimeId, resultHash: hash, complete: true }, null, 2), "utf8");
  // Publish the manifest first so a crash can never leave an apparently final Result without its integrity record.
  renameSync(manifestTmp, manifestRef);
  renameSync(resultTmp, resultRef);
  return { resultRef, resultHash: hash, manifestRef };
}

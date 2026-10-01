import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

function injectFault(t: any, stage: string): void {
  if (stage === "prepare") {
    const original = childProcess.spawnSync;
    t.mock.method(childProcess, "spawnSync", (command: any, ...args: any[]) => command === "tar"
      ? { status: 1, stderr: "archive prepare failure" } : original(command, ...args));
  } else {
    const name = stage === "cleanup" ? "rmSync" : "renameSync";
    const original = fs[name];
    t.mock.method(fs, name, (...args: any[]) => {
      const target = String(stage === "snapshot" ? args[1] : args[0]);
      if (stage === "snapshot" ? /snapshot-\d+$/.test(target) : stage === "cleanup" ? /snapshot-\d+$/.test(target) : target.includes(".tar.zst.")) {
        throw Object.assign(new Error(`Injected ${stage} failure`), { code: "EBUSY" });
      }
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
import { InMemoryProvider, SidmahSystem } from "../src/index.ts";
import { checkMcpConfig } from "../src/maintenance/mcp-config-sync.ts";

const director = { providerSessionId: "director-v43", sessionToken: "director-token-v43" };
const cellMeaning = { responsibility: "v4.3 runtime-contract fixture" };
const startMeaning = { objective: "run fixture", targetAndConditions: "fixed", method: "three stages", observations: "stage output", evaluation: "success" };
const endMeaning = { observedResults: "fixture complete", outputAudit: "checked result.json and stage status", hypothesisJudgement: "supported", reliabilityAndAnomalies: "none", discussion: "runtime boundary verified", references: "result.json" };

function writable(path: string): void {
  try { const s = lstatSync(path); if (s.isDirectory()) for (const name of readdirSync(path)) writable(resolve(path, name)); chmodSync(path, s.mode | 0o200); } catch {}
}

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v43-"));
  writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
  const provider = new InMemoryProvider(), system = new SidmahSystem(root, provider);
  system.startDirector(director);
  return { root, provider, system, cleanup: () => { try { system.close(); } catch {}; writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } };
}

function fixture(root: string, cellNo: number, mutatingStarter = false): void {
  const work = resolve(root, "works", `cell_${cellNo}`, "work_place"); mkdirSync(work, { recursive: true });
  const starter = mutatingStarter
    ? `import{writeFileSync}from'node:fs';writeFileSync('illegal.txt','x');console.log('bad');`
    : `console.log(process.env.SIDMAH_PREFLIGHT==='1'?'preflight-ok':'starter-ok');`;
  const simulator = `import{writeFileSync}from'node:fs';import{resolve}from'node:path';writeFileSync(resolve(process.env.SIDMAH_RUNTIME_OUTPUT,'simulator.out'),'ok');console.log('simulator-ok');`;
  const finisher = `console.log('finisher-ok');`;
  writeFileSync(resolve(work, "starter.mjs"), starter); writeFileSync(resolve(work, "simulator.mjs"), simulator); writeFileSync(resolve(work, "finisher.mjs"), finisher);
  writeFileSync(resolve(work, "experiment.json"), JSON.stringify({ starter: [process.execPath, "starter.mjs"], simulator: [process.execPath, "simulator.mjs"], finisher: [process.execPath, "finisher.mjs"] }));
}

async function boundFixture(x: ReturnType<typeof setup>, mutatingStarter = false) {
  const cell = await x.system.createCell(director, cellMeaning) as any;
  assert.equal(x.provider.spawns.length, 0);
  assert.equal(cell.workerModel, "gpt-5.6-luna"); assert.equal(cell.reasoningEffort, "low");
  await x.system.acceptCell({ providerSessionId: "worker-v43", sessionToken: "unregistered" }, true);
  fixture(x.root, cell.cellNo, mutatingStarter);
  return cell;
}

test("Director owns Worker launch and the Worker claims the unique pending assignment", async (t) => {
  const x = setup(); try {
    const cell = await x.system.createCell(director, cellMeaning) as any;
    assert.equal(x.provider.spawns.length, 0); assert.equal(cell.workerModel, "gpt-5.6-luna"); assert.equal(cell.reasoningEffort, "low");
    const claim = await x.system.acceptCell({ providerSessionId: "worker-claim", sessionToken: "unused" }, true) as any;
    assert.equal(claim.assignmentId, cell.assignmentId); assert.ok(x.system.cells.currentBinding(cell.cellNo));
  } finally { x.cleanup(); }
});

test("ambiguous pending Cell Assignments cannot be claimed by an unregistered Worker", async (t) => {
  const x = setup(); try {
    await x.system.createCell(director, cellMeaning); await x.system.createCell(director, { responsibility: "second" });
    await assert.rejects(() => x.system.acceptCell({ providerSessionId: "ambiguous-worker", sessionToken: "unused" }, true), /Exactly one pending/);
  } finally { x.cleanup(); }
});

test("read-only dynamic preflight rejects a Starter that writes into Snapshot", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x, true); await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await assert.rejects(() => x.system.runtimes.starter(token, { launch: false }), /preflight|read-only|modified/i);
    assert.equal((x.system.runtimes.db.prepare("SELECT state,snapshot_state FROM runtimes").get() as any).state, "created");
  } finally { x.cleanup(); }
});

test("Snapshot commit failure persists classification, attempts, ACL and reusable temporary tree", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x); await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    injectFault(t, "snapshot");
    await assert.rejects(() => x.system.runtimes.starter(token, { launch: false }), /Injected snapshot/);
    t.mock.restoreAll(); syncBuiltinESMExports();
    const failed = x.system.runtimes.db.prepare("SELECT * FROM runtimes").get() as any, diagnostics = JSON.parse(failed.snapshot_diagnostics_json);
    assert.equal(failed.snapshot_state, "commit_failed"); assert.equal(diagnostics.attempts.length, 5); assert.ok(diagnostics.acl); assert.ok(existsSync(failed.snapshot_temporary_path));
    await x.system.runtimes.starter(token, { launch: false });
    assert.equal((x.system.runtimes.db.prepare("SELECT snapshot_state FROM runtimes").get() as any).snapshot_state, "fixed");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); x.cleanup(); }
});

test("archive failure cannot block Result delivery, End creation, or Director review", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const executorToken = (x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token;
    injectFault(t, "prepare"); await x.system.runtimes.executeClaimed(start.runtimeId, executorToken); t.mock.restoreAll(); syncBuiltinESMExports();
    const runtime = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.state, "finished"); assert.equal(runtime.archive_state, "failed"); assert.ok(JSON.parse(runtime.archive_diagnostics_json).attempts.length === 3);
    assert.equal(x.system.cells.activeWorkerItem(token, "result").payload.runtimeId, start.runtimeId);
    x.system.runtimes.createEndAssignment(token, endMeaning); await x.system.pump();
    assert.equal((x.system.runtimes.db.prepare("SELECT state FROM director_inbox").get() as any).state, "active");
    x.system.runtimes.completeEndReview(director.sessionToken);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); x.cleanup(); }
});

test("normal Gate 2 fixture captures stage stdout, stderr and exit code in fixed Result", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const executorToken = (x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token;
    await x.system.runtimes.executeClaimed(start.runtimeId, executorToken);
    const row = x.system.runtimes.db.prepare("SELECT result_ref,archive_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    const result = JSON.parse(readFileSync(row.result_ref, "utf8")); assert.equal(result.executionStatus, "success");
    for (const stage of ["starter", "simulator", "finisher"]) { assert.equal(result.stages[stage].exitCode, 0); assert.equal(result.stages[stage].stderr, ""); assert.match(result.stages[stage].stdout, /ok/); }
  } finally { x.cleanup(); }
});

test("archive rename fault is contained and keeps the original Snapshot", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT executor_token,runtime_no FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    injectFault(t, "rename"); await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token); t.mock.restoreAll(); syncBuiltinESMExports();
    const runtime = x.system.runtimes.db.prepare("SELECT archive_state,result_ref FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.archive_state, "failed"); assert.ok(existsSync(runtime.result_ref));
    assert.ok(existsSync(resolve(x.root, "works", `cell_${cell.cellNo}`, `runtime_${row.runtime_no}`, `snapshot-${row.runtime_no}`)));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); x.cleanup(); }
});

test("archive cleanup fault preserves a valid archive and does not roll back Result", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    injectFault(t, "cleanup"); await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token); t.mock.restoreAll(); syncBuiltinESMExports();
    const runtime = x.system.runtimes.db.prepare("SELECT state,archive_state,cleanup_state,result_ref FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.state, "finished"); assert.equal(runtime.archive_state, "fixed"); assert.equal(runtime.cleanup_state, "failed"); assert.ok(existsSync(runtime.result_ref));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); x.cleanup(); }
});

test("recover isolates an archive fault instead of aborting manager recovery", async (t) => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    injectFault(t, "prepare"); await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token);
    x.system.runtimes.db.prepare("UPDATE runtimes SET archive_state='pending' WHERE runtime_id=?").run(start.runtimeId);
    await x.system.recover(); t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((x.system.runtimes.db.prepare("SELECT state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).state, "finished");
    assert.equal(x.system.cells.activeWorkerItem(token, "result").payload.runtimeId, start.runtimeId);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); x.cleanup(); }
});

test("test-build MCP preflight synchronizes only the SIDMAH entry without an approval state", () => {
  const x = setup(); try {
    const config = resolve(x.root, "config.toml");
    writeFileSync(resolve(x.root, "mcp-config.json"), JSON.stringify({ serverName: "sidmah", command: "node", nodeArgs: ["--experimental-strip-types"], enabled: true, required: false, startupTimeoutSec: 30, toolTimeoutSec: 11200 }));
    writeFileSync(config, "model = 'keep-me'\n\n[mcp_servers.other]\ncommand = 'keep-other'\n\n[mcp_servers.sidmah]\ncommand = 'old'\n");
    const before = checkMcpConfig(x.root, config); assert.equal(before.synced, false);
    const { applyMcpConfig } = requireMcpSync(); const after = applyMcpConfig(x.root, config); assert.equal(after.synced, true);
    const body = readFileSync(config, "utf8"); assert.match(body, /keep-me/); assert.match(body, /keep-other/); assert.doesNotMatch(body, /approval|consent|confirm/i);
  } finally { x.cleanup(); }
});

function requireMcpSync() { return { applyMcpConfig: (root: string, path: string) => importApply(root, path) }; }
import { applyMcpConfig as importApply } from "../src/maintenance/mcp-config-sync.ts";

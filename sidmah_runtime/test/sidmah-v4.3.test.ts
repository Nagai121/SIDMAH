import assert from "node:assert/strict";
import { cpSync, renameSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
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

test("Director owns Worker launch and the Worker claims the unique pending assignment", async () => {
  const x = setup(); try {
    const cell = await x.system.createCell(director, cellMeaning) as any;
    assert.equal(x.provider.spawns.length, 0); assert.equal(cell.workerModel, "gpt-5.6-luna"); assert.equal(cell.reasoningEffort, "low");
    const claim = await x.system.acceptCell({ providerSessionId: "worker-claim", sessionToken: "unused" }, true) as any;
    assert.equal(claim.assignmentId, cell.assignmentId); assert.ok(x.system.cells.currentBinding(cell.cellNo));
  } finally { x.cleanup(); }
});

test("ambiguous pending Cell Assignments cannot be claimed by an unregistered Worker", async () => {
  const x = setup(); try {
    await x.system.createCell(director, cellMeaning); await x.system.createCell(director, { responsibility: "second" });
    await assert.rejects(() => x.system.acceptCell({ providerSessionId: "ambiguous-worker", sessionToken: "unused" }, true), /Exactly one pending/);
  } finally { x.cleanup(); }
});

test("read-only dynamic preflight rejects a Starter that writes into Snapshot", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x, true); await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await assert.rejects(() => x.system.runtimes.starter(token, { launch: false }), /preflight|read-only|modified/i);
    assert.equal((x.system.runtimes.db.prepare("SELECT state,snapshot_state FROM runtimes").get() as any).state, "created");
  } finally { x.cleanup(); }
});

test("Snapshot commit failure persists classification, attempts, ACL and reusable temporary tree", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x); await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    process.env.SIDMAH_TEST_FAIL_SNAPSHOT_RENAME = "1";
    await assert.rejects(() => x.system.runtimes.starter(token, { launch: false }), /Injected snapshot/);
    delete process.env.SIDMAH_TEST_FAIL_SNAPSHOT_RENAME;
    const failed = x.system.runtimes.db.prepare("SELECT * FROM runtimes").get() as any, diagnostics = JSON.parse(failed.snapshot_diagnostics_json);
    assert.equal(failed.snapshot_state, "commit_failed"); assert.equal(diagnostics.attempts.length, 5); assert.ok(diagnostics.acl); assert.ok(existsSync(failed.snapshot_temporary_path));
    await x.system.runtimes.starter(token, { launch: false });
    assert.equal((x.system.runtimes.db.prepare("SELECT snapshot_state FROM runtimes").get() as any).snapshot_state, "fixed");
  } finally { delete process.env.SIDMAH_TEST_FAIL_SNAPSHOT_RENAME; x.cleanup(); }
});

test("archive failure cannot block Result delivery, End creation, or Director review", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const executorToken = (x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token;
    process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE = "prepare"; await x.system.runtimes.executeClaimed(start.runtimeId, executorToken); delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE;
    const runtime = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.state, "finished"); assert.equal(runtime.archive_state, "failed"); assert.ok(JSON.parse(runtime.archive_diagnostics_json).attempts.length === 3);
    assert.equal(x.system.cells.activeWorkerItem(token, "result").payload.runtimeId, start.runtimeId);
    x.system.runtimes.createEndAssignment(token, endMeaning); await x.system.pump();
    assert.equal((x.system.runtimes.db.prepare("SELECT state FROM director_inbox").get() as any).state, "active");
    x.system.runtimes.completeEndReview(director.sessionToken);
  } finally { delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE; x.cleanup(); }
});

test("archive fixture marker injects a prepare failure through the normal Snapshot path", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const work = resolve(x.root, "works", `cell_${cell.cellNo}`, "work_place");
    writeFileSync(resolve(work, "SIDMAH_TEST_FORCE_ARCHIVE_FAILURE"), "test-only fault injection\n");
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const executorToken = (x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token;
    await x.system.runtimes.executeClaimed(start.runtimeId, executorToken);
    const runtime = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.state, "finished"); assert.equal(runtime.archive_state, "failed");
    assert.equal(JSON.parse(runtime.archive_diagnostics_json).attempts.length, 3);
  } finally { x.cleanup(); }
});

test("normal Gate 2 fixture captures stage stdout, stderr and exit code in fixed Result", async () => {
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

test("archive rename fault is contained and keeps the original Snapshot", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT executor_token,runtime_no FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE = "rename"; await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token); delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE;
    const runtime = x.system.runtimes.db.prepare("SELECT archive_state,result_ref FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.archive_state, "failed"); assert.ok(existsSync(runtime.result_ref));
    assert.ok(existsSync(resolve(x.root, "works", `cell_${cell.cellNo}`, `runtime_${row.runtime_no}`, `snapshot-${row.runtime_no}`)));
  } finally { delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE; x.cleanup(); }
});

test("archive cleanup fault preserves a valid archive and does not roll back Result", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE = "cleanup"; await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token); delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE;
    const runtime = x.system.runtimes.db.prepare("SELECT state,archive_state,cleanup_state,result_ref FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(runtime.state, "finished"); assert.equal(runtime.archive_state, "fixed"); assert.equal(runtime.cleanup_state, "failed"); assert.ok(existsSync(runtime.result_ref));
  } finally { delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE; x.cleanup(); }
});

test("recover isolates an archive fault instead of aborting manager recovery", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x); const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
    const token = (x.system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v43'").get() as any).session_token;
    await x.system.runtimes.starter(token, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE = "prepare"; await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token);
    x.system.runtimes.db.prepare("UPDATE runtimes SET archive_state='pending' WHERE runtime_id=?").run(start.runtimeId);
    await x.system.recover(); delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE;
    assert.equal((x.system.runtimes.db.prepare("SELECT state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).state, "finished");
    assert.equal(x.system.cells.activeWorkerItem(token, "result").payload.runtimeId, start.runtimeId);
  } finally { delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE; x.cleanup(); }
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


// v1.0.2 regressions exercise the existing Manager and Provider paths.
test("parallel provisioning uses explicit assignment IDs and rejects mismatched or duplicate claims", async () => {
  const x = setup(); try {
    const first = await x.system.createCell(director, cellMeaning) as any;
    const second = await x.system.createCell(director, { responsibility: "second" }) as any;
    const worker1 = { providerSessionId: "parallel-1", sessionToken: "unused" };
    const worker2 = { providerSessionId: "parallel-2", sessionToken: "unused" };
    const claims = await Promise.all([
      x.system.acceptCell(worker2, true, second.assignmentId),
      x.system.acceptCell(worker1, true, first.assignmentId),
    ]) as any[];
    assert.equal(claims[0].cellNo, second.cellNo); assert.equal(claims[1].cellNo, first.cellNo);
    assert.match(first.bootstrap, new RegExp(first.assignmentId));
    await assert.rejects(() => x.system.acceptCell({ providerSessionId: "third", sessionToken: "unused" }, true, first.assignmentId), /pending Cell/);
    const context = x.system.contextForProviderSession(worker1.providerSessionId);
    await x.system.acceptCell(context, false, first.assignmentId);
    await assert.rejects(() => x.system.acceptCell(context, false, second.assignmentId), /does not belong/);
  } finally { x.cleanup(); }
});

async function pendingSnapshot(x: ReturnType<typeof setup>) {
  const cell = await boundFixture(x);
  const start = await x.system.createStart(director, cell.cellNo, startMeaning, 30_000);
  const context = x.system.contextForProviderSession("worker-v43");
  process.env.SIDMAH_TEST_FAIL_SNAPSHOT_RENAME = "1";
  try { await assert.rejects(() => x.system.runtimes.starter(context.sessionToken, { launch: false }), /Injected snapshot/); }
  finally { delete process.env.SIDMAH_TEST_FAIL_SNAPSHOT_RENAME; }
  const row = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
  x.system.runtimes.db.prepare("UPDATE runtimes SET snapshot_state='commit_pending' WHERE runtime_id=?").run(start.runtimeId);
  return { cell, start, context, row };
}

for (const bothTrees of [false, true]) test(`recovery adopts verified commit_pending Snapshot after rename/freeze, both trees=${bothTrees}`, async () => {
  const x = setup(); try {
    const { start, row } = await pendingSnapshot(x);
    if (bothTrees) cpSync(row.snapshot_temporary_path, row.snapshot_destination_path, { recursive: true });
    else renameSync(row.snapshot_temporary_path, row.snapshot_destination_path);
    for (const name of readdirSync(row.snapshot_destination_path)) {
      const path = resolve(row.snapshot_destination_path, name); chmodSync(path, lstatSync(path).mode & ~0o222);
    }
    chmodSync(row.snapshot_destination_path, lstatSync(row.snapshot_destination_path).mode & ~0o222);
    // The original work_place can change after the successful rename.
    writeFileSync(resolve(row.snapshot_source_path, "new-work.txt"), "later work");
    const launches: string[] = [];
    x.system.runtimes.launchExecutor = async (id: string) => { launches.push(id); };
    await x.system.recover();
    const fixed = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(fixed.state, "launching"); assert.equal(fixed.snapshot_state, "fixed");
    assert.deepEqual(launches, [start.runtimeId]); assert.ok(!existsSync(row.snapshot_temporary_path));
    assert.equal(x.system.cells.workerItemState("start", start.startId), "completed");
    const token = fixed.executor_token;
    await x.system.recover();
    assert.equal((x.system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token, token);
  } finally { x.cleanup(); }
});

for (const temporaryPresent of [false, true]) test(`pending Snapshot resumes Starter with temporary present=${temporaryPresent}`, async () => {
  const x = setup(); try {
    const { start, context, row } = await pendingSnapshot(x);
    if (!temporaryPresent) rmSync(row.snapshot_temporary_path, { recursive: true, force: true });
    await x.system.recover();
    await x.system.runtimes.starter(context.sessionToken, { launch: false });
    assert.equal((x.system.runtimes.db.prepare("SELECT snapshot_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).snapshot_state, "fixed");
  } finally { x.cleanup(); }
});

test("recovery rejects modified committed Snapshot and permits rebuilding", async () => {
  const x = setup(); try {
    const { start, context, row } = await pendingSnapshot(x);
    renameSync(row.snapshot_temporary_path, row.snapshot_destination_path);
    writeFileSync(resolve(row.snapshot_destination_path, "simulator.mjs"), "throw new Error('corrupt');");
    await x.system.recover();
    assert.equal((x.system.runtimes.db.prepare("SELECT snapshot_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).snapshot_state, "none");
    assert.ok(!existsSync(row.snapshot_destination_path));
    await x.system.runtimes.starter(context.sessionToken, { launch: false });
    assert.ok(existsSync(row.snapshot_destination_path));
  } finally { x.cleanup(); }
});

for (const recovery of [false, true]) test(`fixed archive cleanup retries without rewriting archive, recovery=${recovery}`, async () => {
  const x = setup(); try {
    const cell = await boundFixture(x), start = await x.system.createStart(director, cell.cellNo, startMeaning);
    const context = x.system.contextForProviderSession("worker-v43");
    const { snapshotDirectory } = await x.system.runtimes.starter(context.sessionToken, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE = "cleanup";
    await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token);
    delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE;
    const archive = `${snapshotDirectory}.tar.zst`, before = readFileSync(archive);
    if (recovery) {
      x.system.runtimes.db.prepare("UPDATE runtimes SET cleanup_state='pending' WHERE runtime_id=?").run(start.runtimeId);
      await x.system.recover();
    } else await x.system.runtimes.archive(start.runtimeId);
    assert.equal((x.system.runtimes.db.prepare("SELECT cleanup_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).cleanup_state, "complete");
    assert.ok(!existsSync(snapshotDirectory)); assert.deepEqual(readFileSync(archive), before);
    await x.system.runtimes.archive(start.runtimeId);
    assert.deepEqual(readFileSync(archive), before);
  } finally { delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE; x.cleanup(); }
});

test("fixed archive cleanup preserves Snapshot when archive is corrupt or missing", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x), start = await x.system.createStart(director, cell.cellNo, startMeaning);
    const { snapshotDirectory } = await x.system.runtimes.starter(x.system.contextForProviderSession("worker-v43").sessionToken, { launch: false });
    x.system.runtimes.db.prepare("UPDATE runtimes SET state='finished',archive_state='fixed' WHERE runtime_id=?").run(start.runtimeId);
    for (const corrupt of [false, true]) {
      if (corrupt) writeFileSync(`${snapshotDirectory}.tar.zst`, "corrupt");
      await x.system.recover();
      assert.ok(existsSync(snapshotDirectory));
      assert.equal((x.system.runtimes.db.prepare("SELECT cleanup_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).cleanup_state, "failed");
    }
  } finally { x.cleanup(); }
});

import { executePipeline, writeFixedResult } from "../src/runtime/pipeline.ts";
test("Runtime timeout is optional; explicit and very long limits retain their meaning", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x), start = await x.system.createStart(director, cell.cellNo, startMeaning);
    assert.equal((x.system.runtimes.db.prepare("SELECT timeout_ms FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).timeout_ms, 0);
    const { snapshotDirectory } = await x.system.runtimes.starter(x.system.contextForProviderSession("worker-v43").sessionToken, { launch: false });
    for (const limit of [0, 3_000_000_000]) {
      mkdirSync(resolve(x.root, `output-${limit}`), { recursive: true });
      const result = await executePipeline(snapshotDirectory, resolve(x.root, `output-${limit}`), limit);
      assert.equal(result.executionStatus, "success");
    }
    const timed = await executePipeline(snapshotDirectory, resolve(x.root, "timeout-output"), 1);
    assert.equal(timed.executionStatus, "timeout");
    for (const invalid of [0, -1, 1.5, NaN]) await assert.rejects(() => x.system.createStart(director, cell.cellNo, startMeaning, invalid), /positive integer/);
  } finally { x.cleanup(); }
});

test("Starter preflight accepts more than 30 seconds under a user-specified limit", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x);
    writeFileSync(resolve(x.root, "works", `cell_${cell.cellNo}`, "work_place", "starter.mjs"), "setTimeout(()=>console.log('slow-preflight-ok'), 30_200);");
    await x.system.createStart(director, cell.cellNo, startMeaning, 40_000);
    await x.system.runtimes.starter(x.system.contextForProviderSession("worker-v43").sessionToken, { launch: false });
    assert.equal((x.system.runtimes.db.prepare("SELECT snapshot_state FROM runtimes").get() as any).snapshot_state, "fixed");
  } finally { x.cleanup(); }
});

import { PassThrough, Writable } from "node:stream";
import { CodexQueueProvider, terminateCodexThread, wakeCodexThread } from "../src/provider/outbox-provider.ts";
function proxyFixture(rpcError = false) {
  const output = new PassThrough(), requests: any[] = [];
  let closed = false;
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >>> 8, body.length & 255]);
    output.write(Buffer.concat([header, body]));
  };
  const input = new Writable({ write(chunk, _encoding, done) {
    const bytes = Buffer.from(chunk);
    if (bytes.toString().startsWith("GET /")) queueMicrotask(() => output.write("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
    else {
      const length = (bytes[1] & 127) === 126 ? bytes.readUInt16BE(2) : bytes[1] & 127;
      const offset = (bytes[1] & 127) === 126 ? 4 : 2;
      const mask = bytes.subarray(offset, offset + 4), body = Buffer.from(bytes.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      const request = JSON.parse(body.toString()); requests.push(request);
      if (request.id === 1) queueMicrotask(() => frame({ id: 1, result: {} }));
      if (request.id === 2) queueMicrotask(() => frame(rpcError ? { id: 2, error: { message: "archive refused" } } : { id: 2, result: request.method === "thread/resume" ? { thread: { id: request.params.threadId } } : {} }));
    }
    done();
  } });
  return { requests, proxy: { input, output, close: () => { closed = true; }, onFailure: (_handler: (error: Error) => void) => {} }, isClosed: () => closed };
}

test("Codex proxy archives the selected Worker and retains resume behavior", async () => {
  for (const archive of [false, true]) {
    const fixture = proxyFixture();
    await (archive ? terminateCodexThread : wakeCodexThread)("worker-thread", () => fixture.proxy);
    assert.deepEqual(fixture.requests.at(-1), { id: 2, method: archive ? "thread/archive" : "thread/resume", params: { threadId: "worker-thread" } });
    assert.ok(fixture.isClosed());
  }
  const refused = proxyFixture(true);
  await assert.rejects(() => terminateCodexThread("worker-thread", () => refused.proxy), /archive refused/);
  assert.ok(refused.isClosed());
});

test("Codex termination persists intent, invokes RPC, and exposes failures during Director End", async () => {
  const x = setup(); try {
    const ids: string[] = [];
    const provider = new CodexQueueProvider(resolve(x.root, "outbox"), async () => {}, async () => {}, async id => { ids.push(id); });
    await provider.terminate("worker", "ended"); assert.deepEqual(ids, ["worker"]);
    assert.ok(existsSync(resolve(x.root, "outbox", "terminate", `${Buffer.from("worker").toString("base64url")}.json`)));
    await boundFixture(x);
    x.provider.terminate = async () => { throw new Error("RPC unavailable"); };
    const result = await x.system.endDirector(director);
    assert.equal(result.terminationFailures.length, 1);
    assert.match(result.terminationFailures[0].error, /RPC unavailable/);
    assert.equal(x.system.cells.currentBinding(1), undefined);
    assert.equal(x.system.cells.directorRunStatus(result.runId), "ended");
  } finally { x.cleanup(); }
});


import { registerTools } from "../src/mcp/tools.ts";
test("MCP accepts an explicit Cell ID and omits an unspecified Runtime timeout", async () => {
  const x = setup(); try {
    const registered = new Map<string, any>();
    registerTools({ register: (tool: any) => registered.set(tool.name, tool) } as any, async () => x.system);
    const first = await x.system.createCell(director, cellMeaning) as any;
    await x.system.createCell(director, { responsibility: "other pending" });
    const accept = registered.get("accept_cell_assignment");
    assert.ok(accept.inputSchema.properties.assignmentId);
    const claim = await accept.call({ assignmentId: first.assignmentId }, { threadId: "mcp-worker" });
    assert.equal(claim.cellNo, first.cellNo);
    const createStart = registered.get("create_start_assignment");
    assert.ok(!createStart.inputSchema.required.includes("timeoutMs"));
    const start = await createStart.call({ cellNo: first.cellNo, meaning: startMeaning }, { threadId: director.providerSessionId });
    assert.equal((x.system.runtimes.db.prepare("SELECT timeout_ms FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).timeout_ms, 0);
  } finally { x.cleanup(); }
});

test("legacy commit_pending without a manifest validates against the saved source hash", async () => {
  const x = setup(); try {
    const { start, row } = await pendingSnapshot(x);
    renameSync(row.snapshot_temporary_path, row.snapshot_destination_path);
    x.system.runtimes.db.prepare("UPDATE runtimes SET snapshot_diagnostics_json=NULL WHERE runtime_id=?").run(start.runtimeId);
    x.system.runtimes.launchExecutor = async () => {};
    await x.system.recover();
    assert.equal((x.system.runtimes.db.prepare("SELECT snapshot_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).snapshot_state, "fixed");
  } finally { x.cleanup(); }
});


test("synthetic failure preserves a complete filesystem Result that won the executor race", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x), start = await x.system.createStart(director, cell.cellNo, startMeaning);
    const context = x.system.contextForProviderSession("worker-v43");
    const { snapshotDirectory } = await x.system.runtimes.starter(context.sessionToken, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    x.system.runtimes.claimExecution(start.runtimeId, row.executor_token);
    const runtimeDir = resolve(snapshotDirectory, "..");
    const normal = { schemaVersion: 1, executionStatus: "success", stages: {} };
    const fixed = writeFixedResult(runtimeDir, start.runtimeId, normal);
    await (x.system.runtimes as any).finishWithSyntheticFailure(start.runtimeId, "executor_failed", "late recovery");
    const committed = x.system.runtimes.db.prepare("SELECT state,execution_status,result_hash FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(committed.state, "finished"); assert.equal(committed.execution_status, "success"); assert.equal(committed.result_hash, fixed.resultHash);
    assert.equal(JSON.parse(readFileSync(fixed.resultRef, "utf8")).executionStatus, "success");
  } finally { x.cleanup(); }
});

test("archive failure removes its private temporary archive", async () => {
  const x = setup(); try {
    const cell = await boundFixture(x), start = await x.system.createStart(director, cell.cellNo, startMeaning);
    const context = x.system.contextForProviderSession("worker-v43");
    const { snapshotDirectory } = await x.system.runtimes.starter(context.sessionToken, { launch: false });
    const row = x.system.runtimes.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE = "rename";
    await x.system.runtimes.executeClaimed(start.runtimeId, row.executor_token);
    delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE;
    const runtimeDir = resolve(snapshotDirectory, "..");
    assert.equal(readdirSync(runtimeDir).filter(name => name.startsWith(`snapshot-${start.runtimeNo}.tar.zst.`) && name.endsWith(".tmp")).length, 0);
    assert.equal((x.system.runtimes.db.prepare("SELECT archive_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).archive_state, "failed");
  } finally { delete process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE; x.cleanup(); }
});

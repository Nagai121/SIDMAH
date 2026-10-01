import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SidmahSystem, configuredProvider, deliveryMode, OutboxProvider, CodexQueueProvider } from "../src/index.ts";

const meaning = { objective: "delivery regression", targetAndConditions: "non-biochemical fixture", method: "three stages", observations: "fixed Result", evaluation: "all stages succeeded" };
const end = { observedResults: "fixture succeeded", outputAudit: "Result stage exit codes and simulator artifact checked", hypothesisJudgement: "not applicable", reliabilityAndAnomalies: "none", discussion: "relay receipt and review verified", references: "result.json" };

function writable(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) writable(resolve(path, name));
    chmodSync(path, stat.mode | 0o200);
  } catch {}
}

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-relay-"));
  writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
  const system = new SidmahSystem(root, configuredProvider(root));
  system.startDirector(system.contextForProviderSession("relay-director", true));
  return { root, system, director: () => system.contextForProviderSession("relay-director"), cleanup: () => { system.close(); writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test("internal-agent default and executor select collaboration; queue requires explicit selection", () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-provider-config-"));
  try {
    assert.equal(deliveryMode(root), "collaboration");
    assert.ok(configuredProvider(root) instanceof OutboxProvider);
    assert.ok(!(configuredProvider(root) instanceof CodexQueueProvider));
    writeFileSync(resolve(root, "provider-config.json"), JSON.stringify({ mode: "codex-queue" }));
    assert.ok(configuredProvider(root) instanceof CodexQueueProvider);
    writeFileSync(resolve(root, "provider-config.json"), JSON.stringify({ mode: "unknown" }));
    assert.throws(() => configuredProvider(root), /provider-config/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("durable relay leaves Start submitted; polls neither claim nor expose other Workers", async () => {
  const x = setup();
  try {
    const c1 = await x.system.createCell(x.director(), { responsibility: "first" });
    const c2 = await x.system.createCell(x.director(), { responsibility: "second" });
    await x.system.acceptCell(x.system.contextForProviderSession("relay-worker-1", true), true, c1.assignmentId);
    await x.system.acceptCell(x.system.contextForProviderSession("relay-worker-2", true), true, c2.assignmentId);
    await x.system.createStart(x.director(), c1.cellNo, meaning);
    await x.system.createStart(x.director(), c2.cellNo, meaning);
    const worker = x.system.contextForProviderSession("relay-worker-1");
    const p1 = await x.system.getPendingDeliveries(worker);
    const p2 = await x.system.getPendingDeliveries(worker);
    assert.equal(p1.deliveries.length, 1);
    assert.equal(p1.deliveries[0].providerSessionId, "relay-worker-1");
    assert.deepEqual(p1, p2);
    assert.equal((await x.system.getPendingDeliveries(x.director())).deliveries.length, 2);
    assert.equal(x.system.cells.db.prepare("SELECT COUNT(*) n FROM worker_inbox WHERE kind='start' AND state='active'").get()!.n, 0);
    assert.throws(() => x.system.pendingDeliveries({ ...worker, providerSessionId: "relay-worker-2" }), /identity/);
    await x.system.endDirector(x.director());
    assert.throws(() => x.system.pendingDeliveries(worker), /not active/);
  } finally { x.cleanup(); }
});

test("real detached executor delivers Result through relay and End completes Director review", async () => {
  const x = setup();
  try {
    const cell = await x.system.createCell(x.director(), { responsibility: "real relay Runtime" });
    await x.system.acceptCell(x.system.contextForProviderSession("relay-worker", true), true, cell.assignmentId);
    const worker = x.system.contextForProviderSession("relay-worker");
    const work = resolve(x.root, "works", `cell_${cell.cellNo}`, "work_place");
    mkdirSync(work, { recursive: true });
    writeFileSync(resolve(work, "starter.mjs"), "console.log(process.env.SIDMAH_PREFLIGHT==='1'?'preflight-ok':'starter-ok');");
    writeFileSync(resolve(work, "simulator.mjs"), "import{writeFileSync}from'node:fs';import{resolve}from'node:path';writeFileSync(resolve(process.env.SIDMAH_RUNTIME_OUTPUT,'relay.out'),'actual-runtime-output');console.log('simulator-ok');");
    writeFileSync(resolve(work, "finisher.mjs"), "console.log('finisher-ok');");
    writeFileSync(resolve(work, "experiment.json"), JSON.stringify({ starter: [process.execPath, "starter.mjs"], simulator: [process.execPath, "simulator.mjs"], finisher: [process.execPath, "finisher.mjs"] }));
    const start = await x.system.createStart(x.director(), cell.cellNo, meaning);
    assert.equal(start.deliveryMode, "collaboration");
    assert.equal(start.deliveries[0].kind, "start");
    const dispatch = JSON.parse(readFileSync(resolve(x.root, "state", "provider-outbox", "delivery", `${start.deliveries[0].deliveryId}.json`), "utf8"));
    assert.equal(dispatch.payload.runtimeId, start.runtimeId);
    await x.system.starter(worker);
    let deliveries = await x.system.getPendingDeliveries(worker);
    for (let n = 0; n < 200 && !deliveries.deliveries.some(d => d.kind === "result"); n++) {
      await delay(50); deliveries = await x.system.getPendingDeliveries(worker);
    }
    const result = deliveries.deliveries.find(d => d.kind === "result");
    assert.ok(result, "detached executor must enqueue Result");
    for (let n = 0; n < 200; n++) {
      const archive = x.system.runtimes.db.prepare("SELECT archive_state,cleanup_state FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
      if (archive.archive_state === "fixed" && archive.cleanup_state === "complete") break;
      await delay(50);
    }
    await delay(100);
    const row = x.system.runtimes.db.prepare("SELECT state,result_ref FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any;
    assert.equal(row.state, "finished");
    const output = JSON.parse(readFileSync(row.result_ref, "utf8"));
    assert.equal(output.executionStatus, "success");
    assert.equal(output.stages.simulator.exitCode, 0);
    assert.equal(readFileSync(resolve(row.result_ref, "..", "relay.out"), "utf8"), "actual-runtime-output");
    assert.equal((await x.system.getPendingDeliveries(worker)).deliveries[0].deliveryId, result.deliveryId);
    await x.system.createEnd(worker, end);
    assert.equal((await x.system.getPendingDeliveries(worker)).deliveries.length, 0);
    const directorDelivery = await x.system.getPendingDeliveries(x.director());
    assert.equal(directorDelivery.deliveries.length, 1);
    assert.equal(directorDelivery.deliveries[0].kind, "end");
    assert.equal(x.system.runtimes.db.prepare("SELECT state FROM ends WHERE runtime_id=?").get(start.runtimeId)!.state, "submitted");
    await x.system.completeEndReview(x.director());
    assert.equal(x.system.runtimes.db.prepare("SELECT state FROM ends WHERE runtime_id=?").get(start.runtimeId)!.state, "completed");
    assert.equal((await x.system.getPendingDeliveries(x.director())).deliveries.length, 0);
  } catch (error) { console.error(error); throw error; } finally { x.cleanup(); }
});

test("explicit queue rejection stays pending and is never returned as a successful relay", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-queue-failure-"));
  writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna" }));
  writeFileSync(resolve(root, "provider-config.json"), JSON.stringify({ mode: "codex-queue" }));
  let wakeCount = 0;
  const provider = new CodexQueueProvider(resolve(root, "state", "provider-outbox"), async () => { throw new Error("direct app-server input is not allowed for unloaded spawned sub-agents"); }, async () => { wakeCount++; });
  const system = new SidmahSystem(root, provider);
  try {
    system.startDirector(system.contextForProviderSession("queue-director", true));
    const director = system.contextForProviderSession("queue-director");
    const cell = await system.createCell(director, { responsibility: "reject queue" });
    await system.acceptCell(system.contextForProviderSession("queue-worker", true), true, cell.assignmentId);
    const start = await system.createStart(director, cell.cellNo, meaning);
    assert.deepEqual(start.deliveries, []);
    assert.equal(wakeCount, 0);
    assert.equal(system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='start'").get()!.state, "pending");
    await assert.rejects(() => system.starter(system.contextForProviderSession("queue-worker")), /no current inbox/);
  } finally { system.close(); rmSync(root, { recursive: true, force: true }); }
});

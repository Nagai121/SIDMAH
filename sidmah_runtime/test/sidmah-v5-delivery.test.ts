import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexQueueProvider, deliveryMessage, wakeCodexThread } from "../src/provider/outbox-provider.ts";
import { SidmahSystem } from "../src/system.ts";

const director = { providerSessionId: "director-v5", sessionToken: "director-token-v5" };
const startMeaning = { objective: "run fixture", targetAndConditions: "fixed", method: "three stages", observations: "stage output", evaluation: "success" };
const endMeaning = { observedResults: "fixture complete", outputAudit: "result checked", hypothesisJudgement: "supported", reliabilityAndAnomalies: "none", discussion: "delivery checked", references: "result.json" };

function writable(path: string): void {
  try { const s = lstatSync(path); if (s.isDirectory()) for (const name of readdirSync(path)) writable(resolve(path, name)); chmodSync(path, s.mode | 0o200); } catch {}
}

function fixture(root: string, cellNo: number): void {
  const work = resolve(root, "works", `cell_${cellNo}`, "work_place");
  mkdirSync(work, { recursive: true });
  writeFileSync(resolve(work, "starter.mjs"), "console.log('starter-ok');");
  writeFileSync(resolve(work, "simulator.mjs"), "console.log('simulator-ok');");
  writeFileSync(resolve(work, "finisher.mjs"), "console.log('finisher-ok');");
  writeFileSync(resolve(work, "experiment.json"), JSON.stringify({ starter: [process.execPath, "starter.mjs"], simulator: [process.execPath, "simulator.mjs"], finisher: [process.execPath, "finisher.mjs"] }));
}

test("production-style queued Start, Result and End advance on their actual MCP actions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v5-delivery-"));
  const messages: Array<{ threadId: string; message: string }> = [];
  const woken: string[] = [];
  const provider = new CodexQueueProvider(resolve(root, "state", "provider-outbox"), async (threadId, message) => { messages.push({ threadId, message }); }, async threadId => { woken.push(threadId); });
  const system = new SidmahSystem(root, provider);
  try {
    writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
    system.startDirector(director);
    const cell = await system.createCell(director, { responsibility: "delivery fixture" }) as any;
    await system.acceptCell({ providerSessionId: "worker-v5", sessionToken: "unregistered" }, true);
    fixture(root, cell.cellNo);
    const start = await system.createStart(director, cell.cellNo, startMeaning, 30_000) as any;
    const token = (system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v5'").get() as any).session_token;
    assert.equal((system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='start'").get() as any).state, "submitted");
    assert.equal(messages[0].threadId, "worker-v5");
    assert.match(messages[0].message, /SIDMAH Start delivery/);
    const startItem = (system.cells.db.prepare("SELECT item_id FROM worker_inbox WHERE kind='start'").get() as any).item_id;
    await system.cells.checkUnacknowledgedWorker(startItem);
    assert.equal(messages[1].message, messages[0].message);

    await assert.rejects(() => system.runtimes.starter(director.sessionToken, { launch: false }), /active Worker/i);
    await system.runtimes.starter(token, { launch: false });
    await system.cells.checkUnacknowledgedWorker(startItem);
    assert.equal(messages.length, 2);
    const executorToken = (system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token;
    await system.runtimes.executeClaimed(start.runtimeId, executorToken);
    await system.pump();
    assert.equal((system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='result'").get() as any).state, "submitted");
    assert.equal(messages[2].threadId, "worker-v5");
    assert.match(messages[2].message, /SIDMAH Result delivery/);
    const resultItem = (system.cells.db.prepare("SELECT item_id FROM worker_inbox WHERE kind='result'").get() as any).item_id;
    await system.cells.checkUnacknowledgedWorker(resultItem);
    assert.equal(messages[3].message, messages[2].message);
    system.runtimes.createEndAssignment(token, endMeaning);
    await system.pump();
    assert.equal((system.runtimes.db.prepare("SELECT state FROM director_inbox").get() as any).state, "submitted");
    assert.equal(messages[4].threadId, director.providerSessionId);
    assert.match(messages[4].message, /SIDMAH End delivery/);
    const endItem = (system.runtimes.db.prepare("SELECT item_id FROM director_inbox").get() as any).item_id;
    await system.runtimes.checkUnacknowledgedDirector(endItem);
    assert.equal(messages[5].message, messages[4].message);
    system.runtimes.completeEndReview(director.sessionToken);
    await system.runtimes.checkUnacknowledgedDirector(endItem);
    assert.equal(messages.length, 6);
    assert.equal((system.runtimes.db.prepare("SELECT state FROM ends").get() as any).state, "completed");
    for (const name of readdirSync(resolve(root, "state", "provider-outbox", "delivery"))) {
      const item = JSON.parse(readFileSync(resolve(root, "state", "provider-outbox", "delivery", name), "utf8"));
      assert.ok(messages.some(m => m.message.includes(item.deliveryId)));
    }
    assert.deepEqual(woken, ["worker-v5", "worker-v5", "worker-v5", "worker-v5", "director-v5", "director-v5"]);
  } finally { system.close(); writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test("queue failure preserves the durable outbox request instead of falsely marking processing started", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v5-queue-fail-"));
  try {
    const provider = new CodexQueueProvider(resolve(root, "outbox"), async () => { throw new Error("queue unavailable"); });
    const request = { deliveryId: "test-delivery", providerSessionId: "worker-v5", kind: "result" as const, payload: { runtimeId: "runtime" } };
    await assert.rejects(() => provider.deliver(request), /queue unavailable/);
    assert.ok(existsSync(resolve(root, "outbox", "delivery", "test-delivery.json")));
    assert.match(deliveryMessage(request), /create_end_assignment/);
  } finally { writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test("a delivery transport failure leaves the Start pending and does not disable MCP recovery", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v5-recovery-"));
  const provider = new CodexQueueProvider(resolve(root, "state", "provider-outbox"), async () => { throw new Error("Codex transport offline"); });
  const system = new SidmahSystem(root, provider);
  try {
    writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
    system.startDirector(director);
    const cell = await system.createCell(director, { responsibility: "offline transport fixture" }) as any;
    await system.acceptCell({ providerSessionId: "worker-v5", sessionToken: "unregistered" }, true);
    const start = await system.createStart(director, cell.cellNo, startMeaning, 30_000) as any;
    assert.ok(start.runtimeId);
    assert.equal((system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='start'").get() as any).state, "pending");
    await system.recover();
    assert.equal((system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='start'").get() as any).state, "pending");
    assert.match((system.cells.db.prepare("SELECT last_error FROM worker_inbox WHERE kind='start'").get() as any).last_error, /Codex transport offline/);
  } finally { system.close(); writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test("resume failure retries the same queued delivery without adding a second message", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v5-resume-fail-"));
  const messages: string[] = [];
  let wakeCount = 0;
  try {
    const provider = new CodexQueueProvider(resolve(root, "outbox"), async (_threadId, message) => { messages.push(message); }, async () => { if (++wakeCount <= 3) throw new Error("resume unavailable"); });
    const request = { deliveryId: "same-delivery", providerSessionId: "worker-v5", kind: "start" as const, payload: { startId: "start" } };
    await assert.rejects(() => provider.deliver(request), /resume unavailable/);
    await provider.deliver(request);
    assert.equal(messages.length, 1);
    assert.equal(wakeCount, 4);
    assert.ok(existsSync(resolve(root, "outbox", "queued", "same-delivery.json")));
  } finally { writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test("a live Worker delivery recovers after a transient queue failure without another MCP request", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v5-live-retry-"));
  let queueAttempts = 0;
  const provider = new CodexQueueProvider(resolve(root, "state", "provider-outbox"), async () => {
    if (++queueAttempts <= 3) throw new Error("temporary queue failure");
  }, async () => {});
  const system = new SidmahSystem(root, provider);
  try {
    writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
    system.startDirector(director);
    const cell = await system.createCell(director, { responsibility: "retry fixture" }) as any;
    await system.acceptCell({ providerSessionId: "worker-v5", sessionToken: "unregistered" }, true);
    await system.createStart(director, cell.cellNo, startMeaning, 30_000);
    assert.equal((system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='start'").get() as any).state, "pending");
    await delay(3_000);
    assert.equal((system.cells.db.prepare("SELECT state FROM worker_inbox WHERE kind='start'").get() as any).state, "submitted");
    assert.equal(queueAttempts, 4);
    assert.equal((system.cells.db.prepare("SELECT COUNT(*) AS n FROM worker_delivery_attempts").get() as any).n, 1);
  } finally { system.close(); writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test("a live Director End delivery retries after transport failure and keeps one logical End", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-v5-end-retry-"));
  let endAttempts = 0;
  const provider = new CodexQueueProvider(resolve(root, "state", "provider-outbox"), async (_threadId, message) => {
    if (/SIDMAH End delivery/.test(message) && ++endAttempts <= 3) throw new Error("temporary End transport failure");
  }, async () => {});
  const system = new SidmahSystem(root, provider);
  try {
    writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
    system.startDirector(director);
    const cell = await system.createCell(director, { responsibility: "End retry fixture" }) as any;
    await system.acceptCell({ providerSessionId: "worker-v5", sessionToken: "unregistered" }, true);
    fixture(root, cell.cellNo);
    const start = await system.createStart(director, cell.cellNo, startMeaning, 30_000) as any;
    const token = (system.cells.db.prepare("SELECT session_token FROM workers WHERE provider_session_id='worker-v5'").get() as any).session_token;
    await system.runtimes.starter(token, { launch: false });
    const executorToken = (system.runtimes.db.prepare("SELECT executor_token FROM runtimes WHERE runtime_id=?").get(start.runtimeId) as any).executor_token;
    await system.runtimes.executeClaimed(start.runtimeId, executorToken);
    await system.pump();
    system.runtimes.createEndAssignment(token, endMeaning);
    await system.pump();
    assert.equal((system.runtimes.db.prepare("SELECT state FROM director_inbox").get() as any).state, "pending");
    await delay(3_000);
    assert.equal((system.runtimes.db.prepare("SELECT state FROM director_inbox").get() as any).state, "submitted");
    assert.equal(endAttempts, 4);
    assert.equal((system.runtimes.db.prepare("SELECT COUNT(*) AS n FROM director_delivery_attempts").get() as any).n, 1);
  } finally { system.close(); writable(root); rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test("wake client initializes the shared app-server proxy and resumes the target thread", async () => {
  const observed: string[] = [];
  const input = new PassThrough(), output = new PassThrough();
  let data = Buffer.alloc(0), upgraded = false;
  input.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (!upgraded) {
        const end = data.indexOf("\r\n\r\n");
        if (end < 0) return;
        upgraded = true;
        data = data.subarray(end + 4);
        output.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      }
      while (data.length >= 2) {
        const length = data[1] & 0x7f;
        const offset = length === 126 ? 8 : 6;
        if (data.length < offset + (length === 126 ? data.readUInt16BE(2) : length)) return;
        const payloadLength = length === 126 ? data.readUInt16BE(2) : length;
        const mask = data.subarray(offset - 4, offset), payload = Buffer.from(data.subarray(offset, offset + payloadLength));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        data = data.subarray(offset + payloadLength);
        const message = JSON.parse(payload.toString("utf8"));
        observed.push(message.method);
        const response = message.id === 1 ? { id: 1, result: {} } : message.id === 2 ? { id: 2, result: { thread: { id: "worker-v5" } } } : undefined;
        if (response) {
          const bytes = Buffer.from(JSON.stringify(response));
          output.write(Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]));
        }
      }
  });
  await wakeCodexThread("worker-v5", () => ({ input, output, close: () => { input.end(); output.end(); }, onFailure: () => {} }));
  assert.deepEqual(observed, ["initialize", "initialized", "thread/resume"]);
});

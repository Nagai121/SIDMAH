import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { openDb, json, parseJson, transaction } from "../core/db.ts";
import { invariant } from "../core/errors.ts";
import { MachineLog } from "../core/machine-log.ts";
import type { EndMeaning, ProviderHarness } from "../core/types.ts";
import { endMeaning, startMeaning } from "../core/validation.ts";
import type { CellManager } from "./cell-manager.ts";
import { executePipeline, writeFixedResult } from "../runtime/pipeline.ts";

export class RuntimeManager {
  readonly db: DatabaseSync;
  readonly log: MachineLog;
  readonly root: string;
  readonly cells: CellManager;
  readonly provider: ProviderHarness;
  private readonly deliveryRetries = new Map<string, number>();
  private readonly deliveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly receiptChecks = new Map<string, number>();
  private readonly receiptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly receiptDeliveryIds = new Map<string, string>();
  private readonly receiptInFlight = new Set<string>();
  private closed = false;
  constructor(root: string, cells: CellManager, provider: ProviderHarness) {
    this.root = root; this.cells = cells; this.provider = provider;
    this.db = openDb(resolve(root, "state", "runtime_management.sqlite"));
    this.log = new MachineLog(resolve(root, "state", "runtime_management-log.txt"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_counters(cell_no INTEGER PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sequence_counter(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value INTEGER NOT NULL);
      INSERT OR IGNORE INTO sequence_counter VALUES(1,0);
      CREATE TABLE IF NOT EXISTS starts(
        start_id TEXT PRIMARY KEY,runtime_id TEXT NOT NULL UNIQUE,cell_no INTEGER NOT NULL,runtime_no INTEGER NOT NULL,
        meaning_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('dispatch_pending','inbox_registered','completed')),
        created_at INTEGER NOT NULL,UNIQUE(cell_no,runtime_no)
      );
      CREATE TABLE IF NOT EXISTS runtimes(
        runtime_id TEXT PRIMARY KEY,cell_no INTEGER NOT NULL,runtime_no INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('created','launching','running','finished')),
        timeout_ms INTEGER NOT NULL,snapshot_state TEXT NOT NULL,archive_state TEXT NOT NULL,cleanup_state TEXT NOT NULL,
        executor_token TEXT,executor_pid INTEGER,result_ref TEXT,result_hash TEXT,execution_status TEXT,state_version INTEGER NOT NULL DEFAULT 0,
        snapshot_temporary_path TEXT,snapshot_source_path TEXT,snapshot_destination_path TEXT,snapshot_source_hash TEXT,
        snapshot_failure_class TEXT,snapshot_diagnostics_json TEXT,archive_diagnostics_json TEXT,
        UNIQUE(cell_no,runtime_no)
      );
      CREATE TABLE IF NOT EXISTS ends(
        runtime_id TEXT PRIMARY KEY,end_assignment_id TEXT UNIQUE,state TEXT NOT NULL CHECK(state IN('meaning_pending','director_pending','submitting','submitted','active','completed')),
        sequence INTEGER UNIQUE,meaning_json TEXT,delivery_id TEXT UNIQUE,created_at INTEGER NOT NULL,completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS result_contexts(
        context_id TEXT PRIMARY KEY,runtime_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN('dispatch_pending','inbox_registered','consumed')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_dispatch(
        source_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('start','result')),cell_no INTEGER NOT NULL,payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','registered')),created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS director_inbox(
        item_id TEXT PRIMARY KEY,runtime_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,state TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,target_run_id TEXT,target_provider_session_id TEXT,created_at INTEGER NOT NULL,last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS director_slots(run_id TEXT PRIMARY KEY,item_id TEXT NOT NULL UNIQUE,phase TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS director_delivery_attempts(
        delivery_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,target_session_id TEXT NOT NULL,created_at INTEGER NOT NULL
      );
    `);
    const runtimeColumns = this.db.prepare("PRAGMA table_info(runtimes)").all() as any[];
    if (!runtimeColumns.some(column => column.name === "executor_pid")) this.db.exec("ALTER TABLE runtimes ADD COLUMN executor_pid INTEGER");
    for (const [name, type] of [
      ["snapshot_temporary_path", "TEXT"], ["snapshot_source_path", "TEXT"], ["snapshot_destination_path", "TEXT"],
      ["snapshot_source_hash", "TEXT"], ["snapshot_failure_class", "TEXT"], ["snapshot_diagnostics_json", "TEXT"],
      ["archive_diagnostics_json", "TEXT"],
    ]) if (!runtimeColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE runtimes ADD COLUMN ${name} ${type}`);
  }

  createStartAssignment(sessionToken: string, cellNo: number, rawMeaning: unknown, timeoutMs: number): { startId: string; runtimeId: string; runtimeNo: number } {
    const meaning = startMeaning(rawMeaning);
    const caller = this.cells.caller(sessionToken);
    invariant(caller.kind === "director" && caller.status === "active", "DIRECTOR_NOT_ACTIVE", "Only the active Director may create Start");
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "TIMEOUT_INVALID", "Runtime timeout must be a positive integer");
    invariant(this.cells.currentBinding(cellNo), "CELL_HAS_NO_WORKER", "Cell has no active Worker");
    const output = transaction(this.db, () => {
      this.db.prepare("INSERT OR IGNORE INTO runtime_counters VALUES(?,0)").run(cellNo);
      this.db.prepare("UPDATE runtime_counters SET value=value+1 WHERE cell_no=?").run(cellNo);
      const runtimeNo = Number((this.db.prepare("SELECT value FROM runtime_counters WHERE cell_no=?").get(cellNo) as any).value);
      const startId = randomUUID(), runtimeId = randomUUID();
      this.db.prepare("INSERT INTO starts VALUES(?,?,?,?,?,'dispatch_pending',?)").run(startId, runtimeId, cellNo, runtimeNo, json(meaning), Date.now());
      this.db.prepare("INSERT INTO runtimes(runtime_id,cell_no,runtime_no,state,timeout_ms,snapshot_state,archive_state,cleanup_state) VALUES(?,?,?,'created',?,'none','pending','pending')").run(runtimeId, cellNo, runtimeNo, timeoutMs);
      this.db.prepare("INSERT INTO worker_dispatch VALUES(?,'start',?,?,30,'pending',?)").run(startId, cellNo, json({ startId, runtimeId, runtimeNo, cellNo, meaning }), Date.now());
      return { startId, runtimeId, runtimeNo };
    });
    this.log.write("start_committed", output);
    return output;
  }

  drainWorkerDispatch(): number {
    const rows = this.db.prepare("SELECT * FROM worker_dispatch WHERE state='pending' ORDER BY priority,created_at").all() as any[];
    let count = 0;
    for (const row of rows) {
      try {
        this.cells.enqueueWorkerItem(row.cell_no, row.kind, row.source_id, parseJson(row.payload_json), row.priority);
        transaction(this.db, () => {
          this.db.prepare("UPDATE worker_dispatch SET state='registered' WHERE source_id=? AND state='pending'").run(row.source_id);
          if (row.kind === "start") this.db.prepare("UPDATE starts SET state='inbox_registered' WHERE start_id=? AND state='dispatch_pending'").run(row.source_id);
          else this.db.prepare("UPDATE result_contexts SET state='inbox_registered' WHERE context_id=? AND state='dispatch_pending'").run(row.source_id);
        });
        count++;
      } catch (error: any) {
        if (error?.code !== "CELL_HAS_NO_WORKER") throw error;
      }
    }
    return count;
  }

  private validateExperiment(snapshot: string): void {
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

  private freezeSnapshot(path: string): void {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) this.freezeSnapshot(resolve(path, name));
    }
    try { chmodSync(path, stat.mode & ~0o222); } catch {}
  }

  private makeWritable(path: string): void {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) this.makeWritable(resolve(path, name));
    try { chmodSync(path, stat.mode | 0o200); } catch {}
  }

  private treeManifest(root: string): { hash: string; entries: Array<Record<string, unknown>> } {
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

  private aclSummary(path: string): Record<string, unknown> {
    if (process.platform !== "win32") return { platform: process.platform, available: false };
    try {
      const result = spawnSync("icacls", [path], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      return { platform: "win32", available: result.status === 0, status: result.status, stdout: result.stdout?.slice(0, 16_384), stderr: result.stderr?.slice(0, 4_096) };
    } catch (error) { return { platform: "win32", available: false, error: String(error) }; }
  }

  private classifySnapshotFailure(error: any, source: string, destination: string): string {
    if (existsSync(destination)) return "destination_exists";
    if (!existsSync(source)) return "invalid_source_tree";
    if (["EACCES", "EROFS"].includes(error?.code)) return "access_or_acl";
    if (["EBUSY", "ENOTEMPTY"].includes(error?.code)) return "transient_lock";
    if (error?.code === "EPERM") return process.platform === "win32" ? "unknown_windows_lock" : "access_or_acl";
    return "unknown";
  }

  private async runStarterPreflight(workPlace: string, runtimeDir: string, timeoutMs: number): Promise<void> {
    const preflight = resolve(runtimeDir, `.preflight-${randomUUID()}`);
    const preflightOutput = resolve(runtimeDir, `.preflight-output-${randomUUID()}`);
    cpSync(workPlace, preflight, { recursive: true, errorOnExist: true });
    mkdirSync(preflightOutput, { recursive: true });
    try {
      this.validateExperiment(preflight);
      this.freezeSnapshot(preflight);
      const before = this.treeManifest(preflight).hash;
      const contract = JSON.parse(readFileSync(resolve(preflight, "experiment.json"), "utf8"));
      const [command, ...args] = contract.starter as string[];
      const result = spawnSync(command, args, {
        cwd: preflight, encoding: "utf8", windowsHide: true, timeout: Math.max(1, Math.min(timeoutMs, 30_000)),
        env: { ...process.env, SIDMAH_PREFLIGHT: "1", SIDMAH_SNAPSHOT: preflight, SIDMAH_RUNTIME_OUTPUT: preflightOutput },
      });
      const after = this.treeManifest(preflight).hash;
      invariant(result.status === 0 && !result.error, "STARTER_PREFLIGHT_FAILED", `Starter preflight failed: ${result.error ?? result.stderr ?? `exit ${result.status}`}`);
      invariant(before === after, "STARTER_PREFLIGHT_MUTATED", "Starter modified the read-only preflight Snapshot");
    } finally {
      this.makeWritable(preflight);
      rmSync(preflight, { recursive: true, force: true });
      rmSync(preflightOutput, { recursive: true, force: true });
    }
  }

  private async commitSnapshot(runtimeId: string, temporary: string, snapshot: string, workPlace: string, sourceHash: string): Promise<void> {
    const attempts: Array<Record<string, unknown>> = [];
    const waits = [0, 50, 100, 250, 500];
    transaction(this.db, () => this.db.prepare(`UPDATE runtimes SET snapshot_state='commit_pending',snapshot_temporary_path=?,snapshot_source_path=?,snapshot_destination_path=?,snapshot_source_hash=?,snapshot_failure_class=NULL,snapshot_diagnostics_json=NULL WHERE runtime_id=?`).run(temporary, workPlace, snapshot, sourceHash, runtimeId));
    for (let index = 0; index < waits.length; index++) {
      if (waits[index]) await delay(waits[index]);
      const attemptedAt = Date.now();
      try {
        if (process.env.SIDMAH_TEST_FAIL_SNAPSHOT_RENAME === "1") {
          const injected: any = new Error("Injected snapshot rename failure"); injected.code = "EPERM"; throw injected;
        }
        renameSync(temporary, snapshot);
        attempts.push({ attempt: index + 1, attemptedAt, ok: true });
        return;
      } catch (error: any) {
        attempts.push({ attempt: index + 1, attemptedAt, ok: false, code: error?.code, errno: error?.errno, message: String(error) });
        if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code) || index === waits.length - 1) {
          const failureClass = this.classifySnapshotFailure(error, temporary, snapshot);
          const diagnostics = { failureClass, code: error?.code, errno: error?.errno, message: String(error), attempts, temporaryPath: temporary, sourcePath: workPlace, destinationPath: snapshot, sourceHash, manifest: this.treeManifest(temporary), attributes: lstatSync(temporary), acl: this.aclSummary(temporary), recordedAt: Date.now() };
          transaction(this.db, () => this.db.prepare("UPDATE runtimes SET snapshot_state='commit_failed',snapshot_failure_class=?,snapshot_diagnostics_json=? WHERE runtime_id=?").run(failureClass, json(diagnostics), runtimeId));
          this.log.write("snapshot_commit_failed", { runtimeId, ...diagnostics });
          throw error;
        }
      }
    }
  }

  async starter(sessionToken: string, options: { launch?: boolean } = {}): Promise<{ runtimeId: string; snapshotDirectory: string }> {
    const item = this.cells.claimWorkerItemForMcpCall(sessionToken, "start");
    const startId = item.source_id;
    const start = this.db.prepare("SELECT * FROM starts WHERE start_id=?").get(startId) as any;
    invariant(start && start.state === "inbox_registered", "START_NOT_ACTIVE", "Start is not ready for Starter");
    const binding = this.cells.validateWorker(start.cell_no, sessionToken);
    const runtime = this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(start.runtime_id) as any;
    invariant(runtime?.state === "created", "RUNTIME_START_CONFLICT", "Runtime is not in created state");
    const workPlace = resolve(this.root, "works", `cell_${start.cell_no}`, "work_place");
    invariant(existsSync(workPlace), "WORK_PLACE_MISSING", "Cell Work Place does not exist");
    const runtimeDir = resolve(this.root, "works", `cell_${start.cell_no}`, `runtime_${start.runtime_no}`);
    const snapshot = resolve(runtimeDir, `snapshot-${start.runtime_no}`);
    mkdirSync(runtimeDir, { recursive: true });
    await this.runStarterPreflight(workPlace, runtimeDir, runtime.timeout_ms);
    let current = this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(runtime.runtime_id) as any;
    let temporary = current.snapshot_state === "commit_failed" ? current.snapshot_temporary_path : undefined;
    const sourceHash = this.treeManifest(workPlace).hash;
    if (!temporary || !existsSync(temporary) || current.snapshot_source_hash !== sourceHash) {
      temporary = `${snapshot}.${randomUUID()}.tmp`;
      transaction(this.db, () => this.db.prepare("UPDATE runtimes SET snapshot_state='copying',snapshot_temporary_path=?,snapshot_source_path=?,snapshot_destination_path=?,snapshot_source_hash=? WHERE runtime_id=?").run(temporary, workPlace, snapshot, sourceHash, runtime.runtime_id));
      cpSync(workPlace, temporary, { recursive: true, errorOnExist: true });
    }
    this.validateExperiment(temporary);
    await this.commitSnapshot(runtime.runtime_id, temporary, snapshot, workPlace, sourceHash);
    this.freezeSnapshot(snapshot);
    const executorToken = randomUUID();
    try {
      this.cells.withWorkerCommitFence(start.cell_no, sessionToken, "start", startId, binding.fence, () => {
        transaction(this.db, () => {
          const result = this.db.prepare("UPDATE runtimes SET state='launching',snapshot_state='fixed',executor_token=?,snapshot_failure_class=NULL,state_version=state_version+1 WHERE runtime_id=? AND state='created'").run(executorToken, runtime.runtime_id);
          invariant(result.changes === 1, "RUNTIME_START_CONFLICT", "Runtime was started concurrently");
          this.db.prepare("UPDATE starts SET state='completed' WHERE start_id=?").run(startId);
        });
      });
    } catch (error) {
      const current = this.db.prepare("SELECT state FROM runtimes WHERE runtime_id=?").get(runtime.runtime_id) as any;
      if (current?.state === "created" && existsSync(snapshot)) {
        this.makeWritable(snapshot); rmSync(snapshot, { recursive: true, force: true });
        transaction(this.db, () => this.db.prepare("UPDATE runtimes SET snapshot_state='none',snapshot_temporary_path=NULL,snapshot_failure_class=NULL,snapshot_diagnostics_json=NULL WHERE runtime_id=? AND state='created'").run(runtime.runtime_id));
      }
      throw error;
    }
    if (options.launch !== false) await this.launchExecutor(runtime.runtime_id, executorToken);
    this.cells.completeItemBySource("start", startId);
    this.log.write("runtime_handed_off", { runtimeId: runtime.runtime_id, snapshot });
    return { runtimeId: runtime.runtime_id, snapshotDirectory: snapshot };
  }

  claimExecution(runtimeId: string, executorToken: string): any {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=? AND state='launching' AND executor_token=?").get(runtimeId, executorToken) as any;
      invariant(row, "EXECUTOR_CLAIM_REJECTED", "Runtime executor token is not current");
      this.db.prepare("UPDATE runtimes SET state='running',executor_pid=?,state_version=state_version+1 WHERE runtime_id=? AND state='launching'").run(process.pid, runtimeId);
      return row;
    });
  }

  private async launchExecutor(runtimeId: string, executorToken: string): Promise<void> {
    const executor = resolve(import.meta.dirname, "..", "runtime", "executor.ts");
    try {
      const child = spawn(process.execPath, ["--experimental-strip-types", executor, this.root, runtimeId, executorToken], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", error => { void this.finishWithSyntheticFailure(runtimeId, "spawn_failed", String(error)).catch(() => undefined); });
      child.unref();
    } catch (error) {
      await this.finishWithSyntheticFailure(runtimeId, "spawn_failed", String(error));
    }
  }

  async executeClaimed(runtimeId: string, executorToken: string): Promise<void> {
    const runtime = this.claimExecution(runtimeId, executorToken);
    const runtimeDir = resolve(this.root, "works", `cell_${runtime.cell_no}`, `runtime_${runtime.runtime_no}`);
    const snapshot = resolve(runtimeDir, `snapshot-${runtime.runtime_no}`);
    const result = await executePipeline(snapshot, runtimeDir, runtime.timeout_ms);
    const fixed = writeFixedResult(runtimeDir, runtimeId, result);
    this.commitFixedResult(runtimeId, fixed, String((result as any).executionStatus));
    this.drainWorkerDispatch();
    try { await this.cells.dispatchNextForCell(runtime.cell_no); }
    catch (error) { this.log.write("result_delivery_failed", { runtimeId, cellNo: runtime.cell_no, error: String(error) }); }
    await this.archive(runtimeId);
  }

  private async finishWithSyntheticFailure(runtimeId: string, status: string, error: string): Promise<void> {
    const runtime = this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(runtimeId) as any;
    const dir = resolve(this.root, "works", `cell_${runtime.cell_no}`, `runtime_${runtime.runtime_no}`);
    const fixed = writeFixedResult(dir, runtimeId, { schemaVersion: 1, executionStatus: status, error, stages: {} });
    this.commitFixedResult(runtimeId, fixed, status);
  }

  commitFixedResult(runtimeId: string, fixed: { resultRef: string; resultHash: string; manifestRef?: string }, executionStatus: string): void {
    transaction(this.db, () => {
      const runtime = this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(runtimeId) as any;
      invariant(runtime && runtime.state !== "finished", "RUNTIME_ALREADY_FINISHED", "Runtime is already finished");
      const contextId = randomUUID();
      this.db.prepare("UPDATE runtimes SET state='finished',result_ref=?,result_hash=?,execution_status=?,state_version=state_version+1 WHERE runtime_id=?").run(fixed.resultRef, fixed.resultHash, executionStatus, runtimeId);
      this.db.prepare("INSERT INTO ends(runtime_id,state,created_at) VALUES(?,'meaning_pending',?)").run(runtimeId, Date.now());
      this.db.prepare("INSERT INTO result_contexts VALUES(?,?,'dispatch_pending',?)").run(contextId, runtimeId, Date.now());
      this.db.prepare("INSERT INTO worker_dispatch VALUES(?,'result',?,?,10,'pending',?)").run(contextId, runtime.cell_no, json({ contextId, runtimeId, resultRef: fixed.resultRef }), Date.now());
    });
    this.log.write("runtime_finished", { runtimeId, resultRef: fixed.resultRef, executionStatus });
  }

  createEndAssignment(sessionToken: string, rawMeaning: unknown): { endAssignmentId: string; sequence: number } {
    const meaning = endMeaning(rawMeaning);
    const item = this.cells.claimWorkerItemForMcpCall(sessionToken, "result");
    const contextId = item.source_id;
    const context = this.db.prepare("SELECT c.*,r.cell_no FROM result_contexts c JOIN runtimes r ON r.runtime_id=c.runtime_id WHERE c.context_id=?").get(contextId) as any;
    invariant(context && context.state === "inbox_registered", "RESULT_CONTEXT_INVALID", "Active Result context is not available");
    this.cells.validateWorker(context.cell_no, sessionToken);
    const output = transaction(this.db, () => {
      const end = this.db.prepare("SELECT * FROM ends WHERE runtime_id=?").get(context.runtime_id) as any;
      invariant(end?.state === "meaning_pending" && end.end_assignment_id === null, "END_ALREADY_ASSIGNED", "End meaning is already assigned");
      this.db.prepare("UPDATE sequence_counter SET value=value+1 WHERE singleton=1").run();
      const sequence = Number((this.db.prepare("SELECT value FROM sequence_counter WHERE singleton=1").get() as any).value), endAssignmentId = randomUUID(), deliveryId = randomUUID();
      this.db.prepare("UPDATE ends SET end_assignment_id=?,state='director_pending',sequence=?,meaning_json=?,delivery_id=? WHERE runtime_id=? AND state='meaning_pending'").run(endAssignmentId, sequence, json(meaning), deliveryId, context.runtime_id);
      this.db.prepare("UPDATE result_contexts SET state='consumed' WHERE context_id=? AND state='inbox_registered'").run(contextId);
      this.db.prepare("INSERT INTO director_inbox VALUES(?,?,?,'pending',?,NULL,NULL,?,NULL)").run(randomUUID(), context.runtime_id, json({ endAssignmentId, sequence, runtimeId: context.runtime_id, meaning }), deliveryId, Date.now());
      return { endAssignmentId, sequence };
    });
    this.cells.completeWorkerItem(sessionToken, "result", contextId);
    this.log.write("end_meaning_committed", { runtimeId: context.runtime_id, ...output });
    return output;
  }

  async dispatchNextDirector(): Promise<string | undefined> {
    const director = this.cells.activeDirector(); if (!director) return undefined;
    const claim = transaction(this.db, () => {
      const slot = this.db.prepare("SELECT item_id,phase FROM director_slots WHERE run_id=?").get(director.runId) as any;
      if (slot && slot.phase !== "submitting") return undefined;
      const item = slot
        ? this.db.prepare("SELECT * FROM director_inbox WHERE item_id=? AND state='submitting'").get(slot.item_id) as any
        : this.db.prepare("SELECT * FROM director_inbox WHERE state='pending' ORDER BY (SELECT sequence FROM ends WHERE runtime_id=director_inbox.runtime_id),created_at LIMIT 1").get() as any;
      if (!item) return undefined;
      if (!slot) {
        const deliveryId = item.target_provider_session_id === director.providerSessionId ? item.delivery_id : randomUUID();
        this.db.prepare("UPDATE director_inbox SET state='submitting',delivery_id=?,target_run_id=?,target_provider_session_id=?,last_error=NULL WHERE item_id=?").run(deliveryId, director.runId, director.providerSessionId, item.item_id);
        this.db.prepare("INSERT INTO director_slots VALUES(?,?,'submitting')").run(director.runId, item.item_id);
        this.db.prepare("UPDATE ends SET state='submitting' WHERE runtime_id=? AND state='director_pending'").run(item.runtime_id);
        this.db.prepare("UPDATE ends SET delivery_id=? WHERE runtime_id=?").run(deliveryId, item.runtime_id);
        this.db.prepare("INSERT OR IGNORE INTO director_delivery_attempts VALUES(?,?,?,?)").run(deliveryId, item.item_id, director.providerSessionId, Date.now());
        item.delivery_id = deliveryId;
      }
      return { ...item, target_run_id: director.runId, target_provider_session_id: director.providerSessionId };
    });
    if (!claim) return undefined;
    try {
      const result = await this.provider.deliver({ deliveryId: claim.delivery_id, providerSessionId: claim.target_provider_session_id, kind: "end", payload: parseJson(claim.payload_json) });
      invariant(result.accepted, "PROVIDER_REJECTED", "Provider rejected End delivery");
      transaction(this.db, () => {
        const state = result.processingStarted ? "active" : "submitted";
        this.db.prepare("UPDATE director_inbox SET state=? WHERE item_id=? AND state='submitting'").run(state, claim.item_id);
        this.db.prepare("UPDATE director_slots SET phase=? WHERE item_id=? AND phase='submitting'").run(state, claim.item_id);
        this.db.prepare("UPDATE ends SET state=? WHERE runtime_id=? AND state='submitting'").run(state, claim.runtime_id);
      });
      this.deliveryRetries.delete(claim.item_id);
      const timer = this.deliveryRetryTimers.get(claim.item_id);
      if (timer) clearTimeout(timer);
      this.deliveryRetryTimers.delete(claim.item_id);
      if ((this.db.prepare("SELECT state FROM director_inbox WHERE item_id=?").get(claim.item_id) as any)?.state === "submitted") this.scheduleReceiptCheck(claim.item_id);
      return claim.item_id;
    } catch (error) {
      transaction(this.db, () => {
        this.db.prepare("DELETE FROM director_slots WHERE item_id=? AND phase='submitting'").run(claim.item_id);
        this.db.prepare("UPDATE director_inbox SET state='pending',last_error=? WHERE item_id=? AND state='submitting'").run(String(error), claim.item_id);
        this.db.prepare("UPDATE ends SET state='director_pending' WHERE runtime_id=? AND state='submitting'").run(claim.runtime_id);
      });
      const attempts = (this.deliveryRetries.get(claim.item_id) ?? 0) + 1;
      this.deliveryRetries.set(claim.item_id, attempts);
      if (attempts <= 3 && !this.deliveryRetryTimers.has(claim.item_id)) {
        const delayMs = [2_000, 10_000, 30_000][attempts - 1];
        const timer = setTimeout(() => {
          this.deliveryRetryTimers.delete(claim.item_id);
          void this.dispatchNextDirector().catch(retryError =>
            this.log.write("director_delivery_retry_failed", { itemId: claim.item_id, attempt: attempts, error: String(retryError) }));
        }, delayMs);
        this.deliveryRetryTimers.set(claim.item_id, timer);
      }
      throw error;
    }
  }

  private scheduleReceiptCheck(itemId: string): void {
    if (!this.provider.redeliver || this.receiptTimers.has(itemId)) return;
    const deliveryId = (this.db.prepare("SELECT delivery_id FROM director_inbox WHERE item_id=?").get(itemId) as any)?.delivery_id;
    if (!deliveryId) return;
    if (this.receiptDeliveryIds.get(itemId) !== deliveryId) {
      this.receiptChecks.delete(itemId);
      this.receiptDeliveryIds.set(itemId, deliveryId);
    }
    const attempt = this.receiptChecks.get(itemId) ?? 0;
    if (attempt >= 3) return;
    const timer = setTimeout(() => {
      this.receiptTimers.delete(itemId);
      void this.checkUnacknowledgedDirector(itemId).catch(error =>
        this.log.write("director_receipt_check_failed", { itemId, error: String(error) }));
    }, [300_000, 900_000, 1_800_000][attempt]);
    this.receiptTimers.set(itemId, timer);
  }

  async checkUnacknowledgedDirector(itemId: string): Promise<void> {
    if (this.closed || this.receiptInFlight.has(itemId)) return;
    const item = this.db.prepare("SELECT * FROM director_inbox WHERE item_id=? AND state='submitted'").get(itemId) as any;
    if (!item || !this.provider.redeliver) return;
    if (this.receiptDeliveryIds.get(itemId) !== item.delivery_id) {
      this.receiptChecks.delete(itemId);
      this.receiptDeliveryIds.set(itemId, item.delivery_id);
    }
    const director = this.cells.activeDirector();
    if (!director || director.runId !== item.target_run_id || director.providerSessionId !== item.target_provider_session_id) return;
    const attempt = (this.receiptChecks.get(itemId) ?? 0) + 1;
    if (attempt > 3) return;
    this.receiptChecks.set(itemId, attempt);
    this.receiptInFlight.add(itemId);
    try {
      await this.provider.redeliver({ deliveryId: item.delivery_id, providerSessionId: item.target_provider_session_id, kind: "end", payload: parseJson(item.payload_json) });
      this.log.write("director_receipt_retry_sent", { itemId, deliveryId: item.delivery_id, attempt });
    } catch (error) {
      this.log.write("director_receipt_retry_failed", { itemId, deliveryId: item.delivery_id, attempt, error: String(error) });
    } finally {
      this.receiptInFlight.delete(itemId);
    }
    if (this.closed) return;
    if ((this.db.prepare("SELECT state FROM director_inbox WHERE item_id=?").get(itemId) as any)?.state === "submitted") this.scheduleReceiptCheck(itemId);
  }

  private clearReceiptCheck(itemId: string): void {
    const timer = this.receiptTimers.get(itemId);
    if (timer) clearTimeout(timer);
    this.receiptTimers.delete(itemId);
    this.receiptChecks.delete(itemId);
    this.receiptDeliveryIds.delete(itemId);
  }

  markDirectorProcessingStarted(deliveryId: string): void {
    const receipt = this.db.prepare("SELECT item_id FROM director_inbox WHERE delivery_id=?").get(deliveryId) as any;
    transaction(this.db, () => {
      const item = this.db.prepare("SELECT * FROM director_inbox WHERE delivery_id=? AND state IN('submitting','submitted')").get(deliveryId) as any;
      if (!item) return;
      this.db.prepare("UPDATE director_inbox SET state='active' WHERE item_id=? AND state IN('submitting','submitted')").run(item.item_id);
      this.db.prepare("UPDATE director_slots SET phase='active' WHERE item_id=? AND phase IN('submitting','submitted')").run(item.item_id);
      this.db.prepare("UPDATE ends SET state='active' WHERE runtime_id=? AND state IN('submitting','submitted')").run(item.runtime_id);
    });
    if (receipt) this.clearReceiptCheck(receipt.item_id);
  }

  completeEndReview(sessionToken: string): { runtimeId: string } {
    const caller = this.cells.caller(sessionToken);
    invariant(caller.kind === "director" && caller.status === "active", "DIRECTOR_NOT_ACTIVE", "Caller is not active Director");
    const completed = transaction(this.db, () => {
      const item = this.db.prepare(`SELECT i.* FROM director_slots s JOIN director_inbox i ON i.item_id=s.item_id
        WHERE s.run_id=? AND i.target_provider_session_id=?
          AND s.phase IN('submitting','submitted','active') AND i.state IN('submitting','submitted','active')`).get(caller.run_id, caller.provider_session_id) as any;
      invariant(item, "NO_ACTIVE_END", "Director has no active End");
      // This matching review call confirms processing even if the provider callback was delayed.
      this.db.prepare("UPDATE director_inbox SET state='active' WHERE item_id=? AND state IN('submitting','submitted')").run(item.item_id);
      this.db.prepare("UPDATE director_slots SET phase='active' WHERE item_id=? AND phase IN('submitting','submitted')").run(item.item_id);
      this.db.prepare("UPDATE ends SET state='active' WHERE runtime_id=? AND state IN('submitting','submitted')").run(item.runtime_id);
      this.db.prepare("UPDATE director_inbox SET state='completed' WHERE item_id=?").run(item.item_id);
      this.db.prepare("UPDATE ends SET state='completed',completed_at=? WHERE runtime_id=?").run(Date.now(), item.runtime_id);
      this.db.prepare("DELETE FROM director_slots WHERE run_id=?").run(caller.run_id);
      return { runtimeId: item.runtime_id, itemId: item.item_id };
    });
    this.clearReceiptCheck(completed.itemId);
    return { runtimeId: completed.runtimeId };
  }

  releaseDirectorRun(runId: string): void {
    transaction(this.db, () => {
      const rows = this.db.prepare("SELECT item_id,runtime_id FROM director_inbox WHERE target_run_id=? AND state IN('submitting','submitted','active')").all(runId) as any[];
      this.db.prepare("DELETE FROM director_slots WHERE run_id=?").run(runId);
      for (const row of rows) {
        this.clearReceiptCheck(row.item_id);
        this.db.prepare("UPDATE director_inbox SET state='pending',target_run_id=NULL,target_provider_session_id=NULL,last_error='Director session ended' WHERE item_id=?").run(row.item_id);
        this.db.prepare("UPDATE ends SET state='director_pending' WHERE runtime_id=? AND state IN('submitting','submitted','active')").run(row.runtime_id);
      }
    });
  }

  async archive(runtimeId: string): Promise<void> {
    const runtime = this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(runtimeId) as any;
    if (!runtime || runtime.archive_state === "fixed") return;
    const dir = resolve(this.root, "works", `cell_${runtime.cell_no}`, `runtime_${runtime.runtime_no}`), snapshotName = `snapshot-${runtime.runtime_no}`;
    const snapshot = resolve(dir, snapshotName);
    if (!existsSync(snapshot)) return;
    const forcedArchiveStage = process.env.SIDMAH_TEST_FAIL_ARCHIVE_STAGE
      ?? (existsSync(resolve(snapshot, "SIDMAH_TEST_FORCE_ARCHIVE_FAILURE")) ? "prepare" : undefined);
    const attempts: Array<Record<string, unknown>> = [];
    const temporary = resolve(dir, `${snapshotName}.tar.zst.tmp`), final = resolve(dir, `${snapshotName}.tar.zst`);
    try { transaction(this.db, () => this.db.prepare("UPDATE runtimes SET archive_state='archiving',archive_diagnostics_json=NULL WHERE runtime_id=?").run(runtimeId)); }
    catch (error) { this.log.write("snapshot_archive_state_failed", { runtimeId, error: String(error) }); return; }
    for (let attempt=1; attempt<=3; attempt++) {
      try {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
        if (forcedArchiveStage === "prepare") throw new Error("Injected archive prepare failure");
        const result = spawnSync("tar", ["-caf", temporary, "-C", dir, snapshotName], { windowsHide: true });
        if (result.status !== 0 || !existsSync(temporary)) throw new Error(`tar failed: status=${result.status}; ${result.stderr?.toString() ?? ""}`);
        if (forcedArchiveStage === "rename") throw new Error("Injected archive rename failure");
        renameSync(temporary, final);
        transaction(this.db, () => this.db.prepare("UPDATE runtimes SET archive_state='fixed' WHERE runtime_id=?").run(runtimeId));
        try {
          if (forcedArchiveStage === "cleanup") throw new Error("Injected archive cleanup failure");
          this.makeWritable(resolve(dir, snapshotName));
          rmSync(resolve(dir, snapshotName), { recursive: true, force: true });
          transaction(this.db, () => this.db.prepare("UPDATE runtimes SET cleanup_state='complete' WHERE runtime_id=?").run(runtimeId));
        } catch (cleanupError) {
          transaction(this.db, () => this.db.prepare("UPDATE runtimes SET cleanup_state='failed',archive_diagnostics_json=? WHERE runtime_id=?").run(json({ stage: "cleanup", error: String(cleanupError), recordedAt: Date.now() }), runtimeId));
          this.log.write("snapshot_cleanup_failed", { runtimeId, error: String(cleanupError) });
        }
        this.log.write("snapshot_archived", { runtimeId, final }); return;
      } catch (error) { attempts.push({ attempt, at: Date.now(), error: String(error) }); }
    }
    try { transaction(this.db, () => this.db.prepare("UPDATE runtimes SET archive_state='failed',archive_diagnostics_json=? WHERE runtime_id=?").run(json({ stage: "archive", attempts, temporary, final, snapshot, recordedAt: Date.now() }), runtimeId)); }
    catch (error) { this.log.write("snapshot_archive_diagnostics_failed", { runtimeId, error: String(error), attempts }); return; }
    this.log.write("snapshot_archive_failed", { runtimeId, attempts });
  }

  recoverFilesystemResults(): number {
    const rows = this.db.prepare("SELECT * FROM runtimes WHERE state IN('launching','running')").all() as any[];
    let count = 0;
    for (const runtime of rows) {
      const dir = resolve(this.root, "works", `cell_${runtime.cell_no}`, `runtime_${runtime.runtime_no}`), resultRef = resolve(dir, "result.json"), manifestRef = resolve(dir, "result.manifest.json");
      if (!existsSync(resultRef) || !existsSync(manifestRef)) continue;
      const manifest = JSON.parse(readFileSync(manifestRef, "utf8")), body = readFileSync(resultRef, "utf8"), hash = createHash("sha256").update(body).digest("hex");
      if (manifest.complete === true && manifest.runtimeId === runtime.runtime_id && manifest.resultHash === hash) {
        const result = JSON.parse(body);
        this.commitFixedResult(runtime.runtime_id, { resultRef, resultHash: hash }, String(result.executionStatus)); count++;
      }
    }
    return count;
  }

  reconcileWorkerCompletions(): void {
    const starts = this.db.prepare("SELECT start_id FROM starts WHERE state='completed'").all() as any[];
    for (const row of starts) this.cells.completeItemBySource("start", row.start_id);
    const contexts = this.db.prepare("SELECT context_id FROM result_contexts WHERE state='consumed'").all() as any[];
    for (const row of contexts) this.cells.completeItemBySource("result", row.context_id);
  }

  private recoverCreatedSnapshots(): number {
    const rows = this.db.prepare(`SELECT r.*,s.start_id FROM runtimes r JOIN starts s ON s.runtime_id=r.runtime_id
      WHERE r.state='created' AND r.snapshot_state='none'`).all() as any[];
    let recovered = 0;
    for (const runtime of rows) {
      const runtimeDir = resolve(this.root, "works", `cell_${runtime.cell_no}`, `runtime_${runtime.runtime_no}`);
      const snapshot = resolve(runtimeDir, `snapshot-${runtime.runtime_no}`);
      if (!existsSync(snapshot)) continue;
      try {
        this.validateExperiment(snapshot);
        this.freezeSnapshot(snapshot);
      } catch (error) {
        this.makeWritable(snapshot); rmSync(snapshot, { recursive: true, force: true });
        this.log.write("orphan_snapshot_rejected", { runtimeId: runtime.runtime_id, error: String(error) });
        continue;
      }
      if (this.cells.workerItemState("start", runtime.start_id) !== "active") {
        this.makeWritable(snapshot); rmSync(snapshot, { recursive: true, force: true });
        this.log.write("stale_snapshot_discarded", { runtimeId: runtime.runtime_id });
        continue;
      }
      const executorToken = randomUUID();
      const adopted = this.cells.withRecoverableWorkerItem(runtime.cell_no, "start", runtime.start_id, () => transaction(this.db, () => {
        const changed = this.db.prepare("UPDATE runtimes SET state='launching',snapshot_state='fixed',executor_token=?,state_version=state_version+1 WHERE runtime_id=? AND state='created' AND snapshot_state='none'").run(executorToken, runtime.runtime_id);
        if (changed.changes !== 1) return false;
        this.db.prepare("UPDATE starts SET state='completed' WHERE start_id=? AND state='inbox_registered'").run(runtime.start_id);
        return true;
      }));
      if (adopted === true) {
        this.cells.completeItemBySource("start", runtime.start_id);
        this.log.write("snapshot_recovered", { runtimeId: runtime.runtime_id });
        recovered++;
      } else {
        const current = this.db.prepare("SELECT state FROM runtimes WHERE runtime_id=?").get(runtime.runtime_id) as any;
        if (current?.state === "created" && existsSync(snapshot)) { this.makeWritable(snapshot); rmSync(snapshot, { recursive: true, force: true }); }
      }
    }
    return recovered;
  }

  private reconcileDirectorOwnership(): void {
    const rows = this.db.prepare("SELECT DISTINCT target_run_id FROM director_inbox WHERE target_run_id IS NOT NULL AND state IN('submitting','submitted','active')").all() as any[];
    for (const row of rows) if (this.cells.directorRunStatus(row.target_run_id) !== "active") this.releaseDirectorRun(row.target_run_id);
    const slots = this.db.prepare("SELECT DISTINCT run_id FROM director_slots").all() as any[];
    for (const row of slots) if (this.cells.directorRunStatus(row.run_id) !== "active") this.releaseDirectorRun(row.run_id);
  }

  async recover(): Promise<void> {
    this.reconcileDirectorOwnership();
    this.recoverCreatedSnapshots();
    this.recoverFilesystemResults();
    const launching = this.db.prepare("SELECT runtime_id,executor_token FROM runtimes WHERE state='launching'").all() as any[];
    for (const row of launching) await this.launchExecutor(row.runtime_id, row.executor_token);
    const running = this.db.prepare("SELECT runtime_id,executor_pid FROM runtimes WHERE state='running' AND executor_pid IS NOT NULL").all() as any[];
    for (const row of running) {
      let alive = true; try { process.kill(Number(row.executor_pid), 0); } catch { alive = false; }
      if (!alive) await this.finishWithSyntheticFailure(row.runtime_id, "executor_failed", "Runtime executor ended before fixing Result");
    }
    this.reconcileWorkerCompletions();
    this.drainWorkerDispatch();
    for (const cellNo of this.cells.currentBoundCellNumbers()) {
      try { await this.cells.dispatchNextForCell(cellNo); }
      catch (error) { this.log.write("worker_delivery_recovery_failed", { cellNo, error: String(error) }); }
    }
    try { await this.dispatchNextDirector(); }
    catch (error) { this.log.write("director_delivery_recovery_failed", { error: String(error) }); }
    const archives = this.db.prepare("SELECT runtime_id FROM runtimes WHERE state='finished' AND archive_state IN('pending','archiving')").all() as any[];
    for (const row of archives) { try { await this.archive(row.runtime_id); } catch (error) { this.log.write("snapshot_archive_recovery_isolated", { runtimeId: row.runtime_id, error: String(error) }); } }
  }

  close(): void {
    this.closed = true;
    for (const timer of this.deliveryRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.receiptTimers.values()) clearTimeout(timer);
    this.deliveryRetryTimers.clear();
    this.receiptTimers.clear();
    this.db.close();
  }
}

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, json, parseJson, transaction } from "../core/db.ts";
import { invariant } from "../core/errors.ts";
import { MachineLog } from "../core/machine-log.ts";
import type { InboxKind, ProviderHarness } from "../core/types.ts";
import { cellMeaning } from "../core/validation.ts";

type Caller = { session_id: string; provider_session_id: string; kind: "director" | "worker"; run_id: string; worker_id: string | null; status: string };
type Binding = { cell_no: number; worker_id: string; generation: number; fence: string; session_id: string; provider_session_id: string };

export class CellManager {
  readonly db: DatabaseSync;
  readonly log: MachineLog;
  readonly root: string;
  readonly provider: ProviderHarness;
  constructor(root: string, provider: ProviderHarness) {
    this.root = root; this.provider = provider;
    this.db = openDb(resolve(root, "state", "cell_management.sqlite"));
    this.log = new MachineLog(resolve(root, "state", "cell_management-log.txt"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO counters VALUES('cell',0);
      CREATE TABLE IF NOT EXISTS director_runs(
        run_id TEXT PRIMARY KEY, provider_session_id TEXT NOT NULL, session_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN('active','ended')), worker_seq INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_director ON director_runs(status) WHERE status='active';
      CREATE TABLE IF NOT EXISTS cells(cell_no INTEGER PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workers(
        worker_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,worker_no INTEGER NOT NULL,session_token TEXT NOT NULL UNIQUE,
        provider_session_id TEXT,status TEXT NOT NULL CHECK(status IN('provisioning','active','ended','failed')),
        created_at INTEGER NOT NULL,ended_at INTEGER,UNIQUE(run_id,worker_no)
      );
      CREATE TABLE IF NOT EXISTS bindings(
        binding_id TEXT PRIMARY KEY,cell_no INTEGER NOT NULL,worker_id TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL,fence TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN('provisioning','current','released')),created_at INTEGER NOT NULL,released_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_binding_per_cell ON bindings(cell_no) WHERE status IN('provisioning','current');
      CREATE UNIQUE INDEX IF NOT EXISTS current_worker_binding ON bindings(worker_id) WHERE status IN('provisioning','current');
      CREATE TABLE IF NOT EXISTS cell_assignments(
        assignment_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,cell_no INTEGER NOT NULL,worker_id TEXT NOT NULL,
        meaning_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('spawn_pending','active','completed','failed')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_inbox(
        item_id TEXT PRIMARY KEY,cell_no INTEGER NOT NULL,worker_id TEXT,session_id TEXT,kind TEXT NOT NULL,
        source_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,priority INTEGER NOT NULL,state TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,submitted_at INTEGER,active_at INTEGER,completed_at INTEGER,last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_slots(
        session_id TEXT PRIMARY KEY,item_id TEXT NOT NULL UNIQUE,phase TEXT NOT NULL CHECK(phase IN('submitting','submitted','active'))
      );
      CREATE TABLE IF NOT EXISTS worker_delivery_attempts(
        delivery_id TEXT PRIMARY KEY,item_id TEXT NOT NULL,target_session_id TEXT NOT NULL,created_at INTEGER NOT NULL
      );
    `);
  }

  startDirector(providerSessionId: string, sessionToken: string): { runId: string } {
    invariant(providerSessionId && sessionToken, "SESSION_CONTEXT_REQUIRED", "Provider session identity and token are required");
    const runId = transaction(this.db, () => {
      invariant(!this.db.prepare("SELECT 1 FROM director_runs WHERE status='active'").get(), "DIRECTOR_ALREADY_ACTIVE", "Only one Director run may be active");
      invariant(!this.db.prepare("SELECT 1 FROM director_runs WHERE session_token=?").get(sessionToken), "SESSION_TOKEN_REUSED", "A session token cannot identify two runs");
      const id = randomUUID();
      this.db.prepare("INSERT INTO director_runs(run_id,provider_session_id,session_token,status,started_at) VALUES(?,?,?,'active',?)").run(id, providerSessionId, sessionToken, Date.now());
      return id;
    });
    this.log.write("director_started", { runId, providerSessionId });
    return { runId };
  }

  caller(sessionToken: string): Caller {
    const director = this.db.prepare("SELECT NULL session_id,provider_session_id,'director' kind,run_id,NULL worker_id,status FROM director_runs WHERE session_token=?").get(sessionToken) as Caller | undefined;
    if (director) return director;
    const worker = this.db.prepare("SELECT provider_session_id session_id,provider_session_id,'worker' kind,run_id,worker_id,status FROM workers WHERE session_token=?").get(sessionToken) as Caller | undefined;
    invariant(worker, "CALLER_UNKNOWN", "Caller session token is not registered");
    return worker;
  }

  callerByProviderSessionId(providerSessionId: string): (Caller & { session_token: string }) | undefined {
    const director = this.db.prepare("SELECT NULL session_id,provider_session_id,session_token,'director' kind,run_id,NULL worker_id,status FROM director_runs WHERE provider_session_id=? AND status='active' ORDER BY started_at DESC LIMIT 1").get(providerSessionId) as (Caller & { session_token: string }) | undefined;
    if (director) return director;
    return this.db.prepare("SELECT provider_session_id session_id,provider_session_id,session_token,'worker' kind,run_id,worker_id,status FROM workers WHERE provider_session_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").get(providerSessionId) as (Caller & { session_token: string }) | undefined;
  }

  activeDirector(): { runId: string; providerSessionId: string } | undefined {
    const row = this.db.prepare("SELECT run_id,provider_session_id FROM director_runs WHERE status='active'").get() as any;
    return row ? { runId: row.run_id, providerSessionId: row.provider_session_id } : undefined;
  }

  directorRunStatus(runId: string): "active" | "ended" | undefined {
    const row = this.db.prepare("SELECT status FROM director_runs WHERE run_id=?").get(runId) as any;
    return row?.status;
  }

  currentBinding(cellNo: number): Binding | undefined {
    return this.db.prepare(`SELECT b.cell_no,b.worker_id,b.generation,b.fence,w.provider_session_id session_id,w.provider_session_id
      FROM bindings b JOIN workers w ON w.worker_id=b.worker_id
      WHERE b.cell_no=? AND b.status='current' AND w.status='active'`) .get(cellNo) as Binding | undefined;
  }

  currentBoundCellNumbers(): number[] {
    return (this.db.prepare("SELECT cell_no FROM bindings WHERE status='current' ORDER BY cell_no").all() as any[]).map(row => Number(row.cell_no));
  }

  configuredWorkerModel(): { model: string; reasoningEffort: string } {
    let parsed: any;
    try { parsed = JSON.parse(readFileSync(resolve(this.root, "worker-model.json"), "utf8")); }
    catch { invariant(false, "WORKER_MODEL_CONFIG_INVALID", "worker-model.json must exist and contain valid JSON"); }
    const model = parsed?.model, reasoningEffort = parsed?.reasoning_effort ?? "low";
    invariant(typeof model === "string" && model.trim().length > 0 && model.trim() !== "<worker-model>", "WORKER_MODEL_NOT_CONFIGURED", "Worker model must be confirmed in worker-model.json before creating a Worker");
    invariant(typeof reasoningEffort === "string" && reasoningEffort.trim().length > 0, "WORKER_MODEL_CONFIG_INVALID", "Worker reasoning effort must be configured");
    return { model: model.trim(), reasoningEffort: reasoningEffort.trim() };
  }

  validateWorker(cellNo: number, sessionToken: string, fence?: string): Binding {
    const caller = this.caller(sessionToken);
    invariant(caller.kind === "worker" && caller.status === "active", "WORKER_NOT_ACTIVE", "Caller is not an active Worker");
    const binding = this.currentBinding(cellNo);
    invariant(binding && binding.worker_id === caller.worker_id, "BINDING_INVALID", "Caller is not the current Worker for this Cell");
    if (fence !== undefined) invariant(binding.fence === fence, "FENCE_INVALID", "Binding fence is stale");
    return binding;
  }

  async createCellAssignment(sessionToken: string, rawMeaning: unknown, existingCellNo?: number): Promise<Record<string, unknown>> {
    const meaning = cellMeaning(rawMeaning);
    const caller = this.caller(sessionToken);
    invariant(caller.kind === "director" && caller.status === "active", "DIRECTOR_NOT_ACTIVE", "Only the active Director may create a Cell Assignment");
    const workerModel = this.configuredWorkerModel();
    const created = transaction(this.db, () => {
      let cellNo = existingCellNo;
      if (cellNo === undefined) {
        this.db.prepare("UPDATE counters SET value=value+1 WHERE name='cell'").run();
        cellNo = Number((this.db.prepare("SELECT value FROM counters WHERE name='cell'").get() as any).value);
        this.db.prepare("INSERT INTO cells VALUES(?,?)").run(cellNo, Date.now());
      } else {
        invariant(this.db.prepare("SELECT 1 FROM cells WHERE cell_no=?").get(cellNo), "CELL_NOT_FOUND", "Existing Cell does not exist");
        invariant(!this.db.prepare("SELECT 1 FROM bindings WHERE cell_no=? AND status IN('provisioning','current')").get(cellNo), "CELL_ALREADY_BOUND", "Cell already has a current Binding");
      }
      this.db.prepare("UPDATE director_runs SET worker_seq=worker_seq+1 WHERE run_id=? AND status='active'").run(caller.run_id);
      const workerNo = Number((this.db.prepare("SELECT worker_seq FROM director_runs WHERE run_id=?").get(caller.run_id) as any).worker_seq);
      const workerId = randomUUID(), assignmentId = randomUUID(), workerToken = randomUUID(), fence = randomUUID(), itemId = randomUUID();
      const generation = Number((this.db.prepare("SELECT COALESCE(MAX(generation),0)+1 value FROM bindings WHERE cell_no=?").get(cellNo) as any).value);
      this.db.prepare("INSERT INTO workers(worker_id,run_id,worker_no,session_token,status,created_at) VALUES(?,?,?,?, 'provisioning',?)").run(workerId, caller.run_id, workerNo, workerToken, Date.now());
      this.db.prepare("INSERT INTO bindings(binding_id,cell_no,worker_id,generation,fence,status,created_at) VALUES(?,?,?,?,?,'provisioning',?)").run(randomUUID(), cellNo, workerId, generation, fence, Date.now());
      this.db.prepare("INSERT INTO cell_assignments VALUES(?,?,?,?,?,'spawn_pending',?)").run(assignmentId, caller.run_id, cellNo, workerId, json(meaning), Date.now());
      this.db.prepare("INSERT INTO worker_inbox(item_id,cell_no,worker_id,kind,source_id,payload_json,priority,state,delivery_id,created_at) VALUES(?,?,?,'cell',?,?,0,'submitting',?,?)").run(itemId, cellNo, workerId, assignmentId, json({ assignmentId, cellNo, workerNo, meaning, fence }), assignmentId, Date.now());
      return { assignmentId, cellNo, workerNo, workerId, workerToken, fence, itemId, meaning };
    });
    return {
      assignmentId: created.assignmentId, cellNo: created.cellNo, workerNo: created.workerNo,
      workerModel: workerModel.model, reasoningEffort: workerModel.reasoningEffort,
      bootstrap: "あなたはWorkerである。./worker_skill/SKILL.mdに従い、Systemから渡された現在の一件だけを処理する。最初にaccept_cell_assignmentを呼ぶ。",
      assignment: { assignmentId: created.assignmentId, cellNo: created.cellNo, workerNo: created.workerNo, meaning: created.meaning, fence: created.fence },
    };
  }

  claimPendingCellAssignment(providerSessionId: string): { assignmentId: string; cellNo: number; workerNo: number } {
    return transaction(this.db, () => {
      const rows = this.db.prepare(`SELECT a.assignment_id,a.cell_no,a.worker_id,w.worker_no,i.item_id
        FROM cell_assignments a JOIN workers w ON w.worker_id=a.worker_id
        JOIN bindings b ON b.worker_id=w.worker_id JOIN director_runs d ON d.run_id=a.run_id
        JOIN worker_inbox i ON i.source_id=a.assignment_id
        WHERE a.state='spawn_pending' AND w.status='provisioning' AND b.status='provisioning' AND d.status='active'
        ORDER BY a.created_at`).all() as any[];
      invariant(rows.length === 1, rows.length === 0 ? "CELL_ASSIGNMENT_NOT_FOUND" : "CELL_ASSIGNMENT_AMBIGUOUS", "Exactly one pending Cell Assignment is required for an unregistered Worker claim");
      const row = rows[0];
      invariant(!this.callerByProviderSessionId(providerSessionId), "SESSION_ALREADY_REGISTERED", "Provider session is already registered");
      this.db.prepare("UPDATE workers SET provider_session_id=?,status='active' WHERE worker_id=? AND status='provisioning'").run(providerSessionId, row.worker_id);
      this.db.prepare("UPDATE bindings SET status='current' WHERE worker_id=? AND status='provisioning'").run(row.worker_id);
      this.db.prepare("UPDATE cell_assignments SET state='completed' WHERE assignment_id=? AND state='spawn_pending'").run(row.assignment_id);
      this.db.prepare("UPDATE worker_inbox SET session_id=?,state='completed',submitted_at=?,active_at=?,completed_at=? WHERE item_id=?").run(providerSessionId, Date.now(), Date.now(), Date.now(), row.item_id);
      this.db.prepare("UPDATE worker_inbox SET worker_id=?,session_id=NULL,state='pending' WHERE cell_no=? AND worker_id IS NULL").run(row.worker_id, row.cell_no);
      this.log.write("worker_claimed_cell_assignment", { assignmentId: row.assignment_id, providerSessionId, cellNo: row.cell_no });
      return { assignmentId: row.assignment_id, cellNo: row.cell_no, workerNo: row.worker_no };
    });
  }

  withWorkerCommitFence<T>(cellNo: number, sessionToken: string, expectedKind: InboxKind, sourceId: string, fence: string, body: () => T): T {
    return transaction(this.db, () => {
      const caller = this.caller(sessionToken);
      invariant(caller.kind === "worker" && caller.status === "active", "WORKER_NOT_ACTIVE", "Caller is not an active Worker");
      const binding = this.currentBinding(cellNo);
      invariant(binding && binding.worker_id === caller.worker_id && binding.fence === fence, "FENCE_INVALID", "Binding fence is stale");
      const item = this.db.prepare(`SELECT i.kind,i.source_id FROM worker_slots s JOIN worker_inbox i ON i.item_id=s.item_id
        WHERE s.session_id=? AND s.phase='active' AND i.state='active'`).get(caller.provider_session_id) as any;
      invariant(item && item.kind === expectedKind && item.source_id === sourceId, "WRONG_ACTIVE_ITEM", "Active item changed before commit");
      return body();
    });
  }

  withRecoverableWorkerItem<T>(cellNo: number, expectedKind: InboxKind, sourceId: string, body: () => T): T | undefined {
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT i.item_id
        FROM worker_inbox i
        JOIN workers w ON w.worker_id=i.worker_id
        JOIN bindings b ON b.worker_id=w.worker_id
        JOIN worker_slots s ON s.session_id=i.session_id AND s.item_id=i.item_id
        WHERE i.cell_no=? AND i.kind=? AND i.source_id=? AND i.state='active'
          AND s.phase='active' AND w.status='active' AND b.status='current' AND b.cell_no=i.cell_no
          AND w.provider_session_id=i.session_id`).get(cellNo, expectedKind, sourceId) as any;
      if (!row) return undefined;
      return body();
    });
  }

  workerItemState(kind: InboxKind, sourceId: string): string | undefined {
    const row = this.db.prepare("SELECT state FROM worker_inbox WHERE kind=? AND source_id=?").get(kind, sourceId) as any;
    return row?.state;
  }

  enqueueWorkerItem(cellNo: number, kind: Exclude<InboxKind,"cell">, sourceId: string, payload: unknown, priority: number): string {
    return transaction(this.db, () => {
      const prior = this.db.prepare("SELECT item_id FROM worker_inbox WHERE source_id=?").get(sourceId) as any;
      if (prior) return prior.item_id;
      const binding = this.currentBinding(cellNo);
      invariant(binding, "CELL_HAS_NO_WORKER", "Cell has no active Worker");
      const itemId = randomUUID();
      this.db.prepare("INSERT INTO worker_inbox(item_id,cell_no,worker_id,kind,source_id,payload_json,priority,state,delivery_id,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)")
        .run(itemId, cellNo, binding.worker_id, kind, sourceId, json(payload), priority, randomUUID(), Date.now());
      return itemId;
    });
  }

  async dispatchNextForCell(cellNo: number): Promise<string | undefined> {
    const claim = transaction(this.db, () => {
      const binding = this.currentBinding(cellNo); if (!binding) return undefined;
      const slot = this.db.prepare("SELECT item_id,phase FROM worker_slots WHERE session_id=?").get(binding.provider_session_id) as any;
      if (slot && slot.phase !== "submitting") return undefined;
      const item = slot
        ? this.db.prepare("SELECT * FROM worker_inbox WHERE item_id=? AND state='submitting'").get(slot.item_id) as any
        : this.db.prepare("SELECT * FROM worker_inbox WHERE cell_no=? AND state='pending' ORDER BY priority,created_at,item_id LIMIT 1").get(cellNo) as any;
      if (!item) return undefined;
      if (!slot) {
        const deliveryId = item.session_id === binding.provider_session_id ? item.delivery_id : randomUUID();
        this.db.prepare("UPDATE worker_inbox SET worker_id=?,session_id=?,delivery_id=?,state='submitting',last_error=NULL WHERE item_id=?").run(binding.worker_id, binding.provider_session_id, deliveryId, item.item_id);
        this.db.prepare("INSERT INTO worker_slots VALUES(?,?,'submitting')").run(binding.provider_session_id, item.item_id);
        this.db.prepare("INSERT OR IGNORE INTO worker_delivery_attempts VALUES(?,?,?,?)").run(deliveryId, item.item_id, binding.provider_session_id, Date.now());
        item.delivery_id = deliveryId;
      }
      return { ...item, session_id: binding.provider_session_id };
    });
    if (!claim) return undefined;
    try {
      const accepted = await this.provider.deliver({ deliveryId: claim.delivery_id, providerSessionId: claim.session_id, kind: claim.kind, payload: parseJson(claim.payload_json) });
      invariant(accepted.accepted, "PROVIDER_REJECTED", "Provider rejected delivery");
      transaction(this.db, () => {
        const state = accepted.processingStarted ? "active" : "submitted";
        this.db.prepare("UPDATE worker_inbox SET state=?,submitted_at=?,active_at=CASE WHEN ?='active' THEN ? ELSE active_at END WHERE item_id=? AND state='submitting'").run(state, Date.now(), state, Date.now(), claim.item_id);
        this.db.prepare("UPDATE worker_slots SET phase=? WHERE item_id=? AND phase='submitting'").run(state, claim.item_id);
      });
      return claim.item_id;
    } catch (error) {
      transaction(this.db, () => {
        this.db.prepare("DELETE FROM worker_slots WHERE item_id=? AND phase='submitting'").run(claim.item_id);
        this.db.prepare("UPDATE worker_inbox SET state='pending',last_error=? WHERE item_id=? AND state='submitting'").run(String(error), claim.item_id);
      });
      throw error;
    }
  }

  markProviderProcessingStarted(deliveryId: string): void {
    transaction(this.db, () => {
      const row = this.db.prepare("SELECT item_id FROM worker_inbox WHERE delivery_id=? AND state IN('submitting','submitted')").get(deliveryId) as any;
      if (!row) return;
      this.db.prepare("UPDATE worker_inbox SET state='active',active_at=? WHERE item_id=? AND state IN('submitting','submitted')").run(Date.now(), row.item_id);
      this.db.prepare("UPDATE worker_slots SET phase='active' WHERE item_id=? AND phase IN('submitting','submitted')").run(row.item_id);
    });
  }

  activeWorkerItem(sessionToken: string, expectedKind?: InboxKind): any {
    const caller = this.caller(sessionToken);
    invariant(caller.kind === "worker" && caller.status === "active", "WORKER_NOT_ACTIVE", "Caller is not an active Worker");
    const row = this.db.prepare(`SELECT i.* FROM worker_slots s JOIN worker_inbox i ON i.item_id=s.item_id
      WHERE s.session_id=? AND s.phase='active' AND i.state='active'`).get(caller.provider_session_id) as any;
    invariant(row, "NO_ACTIVE_INBOX_ITEM", "Worker has no active inbox item");
    if (expectedKind) invariant(row.kind === expectedKind, "WRONG_ACTIVE_ITEM", `Active item is not ${expectedKind}`);
    return { ...row, payload: parseJson(row.payload_json) };
  }

  completeWorkerItem(sessionToken: string, expectedKind: InboxKind, sourceId?: string): void {
    transaction(this.db, () => {
      const caller = this.caller(sessionToken);
      const row = this.db.prepare(`SELECT i.* FROM worker_slots s JOIN worker_inbox i ON i.item_id=s.item_id WHERE s.session_id=? AND s.phase='active'`).get(caller.provider_session_id) as any;
      invariant(row && row.kind === expectedKind, "WRONG_ACTIVE_ITEM", `Active item is not ${expectedKind}`);
      if (sourceId) invariant(row.source_id === sourceId, "SOURCE_CONTEXT_MISMATCH", "Active item source does not match");
      this.db.prepare("UPDATE worker_inbox SET state='completed',completed_at=? WHERE item_id=?").run(Date.now(), row.item_id);
      this.db.prepare("DELETE FROM worker_slots WHERE session_id=?").run(caller.provider_session_id);
      if (expectedKind === "cell") this.db.prepare("UPDATE cell_assignments SET state='completed' WHERE assignment_id=?").run(row.source_id);
    });
  }

  acknowledgeCellAssignment(sessionToken: string): void { this.completeWorkerItem(sessionToken, "cell"); }

  completeItemBySource(kind: Exclude<InboxKind,"cell">, sourceId: string): void {
    transaction(this.db, () => {
      const row = this.db.prepare("SELECT item_id,session_id,state FROM worker_inbox WHERE kind=? AND source_id=?").get(kind, sourceId) as any;
      if (!row || row.state === "completed") return;
      this.db.prepare("UPDATE worker_inbox SET state='completed',completed_at=? WHERE item_id=?").run(Date.now(), row.item_id);
      if (row.session_id) this.db.prepare("DELETE FROM worker_slots WHERE session_id=? AND item_id=?").run(row.session_id, row.item_id);
    });
  }

  async endWorkerSessionByToken(sessionToken: string, reason: string): Promise<void> {
    const caller = this.caller(sessionToken);
    invariant(caller.kind === "worker", "WORKER_REQUIRED", "Caller is not a Worker");
    transaction(this.db, () => this.releaseWorker(caller.worker_id!, reason));
  }

  async endWorkerSessionByProviderId(providerSessionId: string, reason: string): Promise<boolean> {
    const row = this.db.prepare("SELECT worker_id FROM workers WHERE provider_session_id=? AND status IN('active','provisioning')").get(providerSessionId) as any;
    if (!row) return false;
    transaction(this.db, () => this.releaseWorker(row.worker_id, reason));
    return true;
  }

  activeDirectorByProviderId(providerSessionId: string): { runId: string; sessionToken: string } | undefined {
    const row = this.db.prepare("SELECT run_id,session_token FROM director_runs WHERE provider_session_id=? AND status='active'").get(providerSessionId) as any;
    return row ? { runId: row.run_id, sessionToken: row.session_token } : undefined;
  }

  private releaseWorker(workerId: string, reason: string): void {
    const worker = this.db.prepare("SELECT provider_session_id FROM workers WHERE worker_id=? AND status IN('active','provisioning')").get(workerId) as any;
    if (!worker) return;
    if (worker.provider_session_id) {
      const slot = this.db.prepare("SELECT item_id FROM worker_slots WHERE session_id=?").get(worker.provider_session_id) as any;
      if (slot) {
        const item = this.db.prepare("SELECT kind FROM worker_inbox WHERE item_id=?").get(slot.item_id) as any;
        this.db.prepare("UPDATE worker_inbox SET state=CASE WHEN kind='cell' THEN 'cancelled' ELSE 'pending' END,worker_id=NULL,session_id=NULL,priority=CASE WHEN kind='result' THEN 10 ELSE 20 END,last_error=? WHERE item_id=?").run(reason, slot.item_id);
        this.db.prepare("DELETE FROM worker_slots WHERE session_id=?").run(worker.provider_session_id);
      }
    }
    const binding = this.db.prepare("SELECT cell_no FROM bindings WHERE worker_id=? AND status IN('current','provisioning')").get(workerId) as any;
    this.db.prepare("UPDATE bindings SET status='released',released_at=?,fence=? WHERE worker_id=?").run(Date.now(), `invalid:${randomUUID()}`, workerId);
    this.db.prepare("UPDATE workers SET status='ended',ended_at=? WHERE worker_id=?").run(Date.now(), workerId);
    this.db.prepare("UPDATE cell_assignments SET state='failed' WHERE worker_id=? AND state IN('spawn_pending','active')").run(workerId);
    if (binding) this.db.prepare("UPDATE worker_inbox SET worker_id=NULL,session_id=NULL,state='pending' WHERE cell_no=? AND kind IN('start','result') AND state IN('pending','submitting','submitted','active')").run(binding.cell_no);
  }

  async endDirector(sessionToken: string): Promise<{ runId: string }> {
    const caller = this.caller(sessionToken);
    invariant(caller.kind === "director" && caller.status === "active", "DIRECTOR_NOT_ACTIVE", "Caller is not the active Director");
    const sessions = transaction(this.db, () => {
      const rows = this.db.prepare("SELECT worker_id,provider_session_id FROM workers WHERE run_id=? AND status IN('active','provisioning')").all(caller.run_id) as any[];
      for (const row of rows) this.releaseWorker(row.worker_id, "Director run ended");
      this.db.prepare("UPDATE director_runs SET status='ended',ended_at=? WHERE run_id=? AND status='active'").run(Date.now(), caller.run_id);
      return rows.map(x => x.provider_session_id).filter(Boolean);
    });
    await Promise.all(sessions.map(id => this.provider.terminate(id, "Director run ended")));
    this.log.write("director_ended", { runId: caller.run_id });
    return { runId: caller.run_id };
  }

  async recover(): Promise<void> {
    const cells = this.db.prepare("SELECT cell_no FROM bindings WHERE status='current'").all() as any[];
    for (const row of cells) await this.dispatchNextForCell(row.cell_no);
  }

  close(): void { this.db.close(); }
}

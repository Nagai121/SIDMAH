import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { invariant } from "./core/errors.ts";
import type { ProviderHarness, ProviderDeliveryRequest } from "./core/types.ts";
import { deliveryMessage } from "./provider/outbox-provider.ts";
import { deliveryMode } from "./provider/configured-provider.ts";
import { CellManager } from "./manager/cell-manager.ts";
import { RuntimeManager } from "./manager/runtime-manager.ts";
import { SessionController } from "./session/session-controller.ts";

export interface CallerContext { sessionToken: string; providerSessionId: string }

export class SidmahSystem {
  readonly root: string;
  readonly sessions: SessionController;
  readonly cells: CellManager;
  readonly runtimes: RuntimeManager;
  constructor(root: string, provider: ProviderHarness) {
    this.root = root;
    this.sessions = new SessionController(provider);
    this.cells = new CellManager(root, this.sessions);
    this.runtimes = new RuntimeManager(root, this.cells, this.sessions);
  }

  contextForProviderSession(providerSessionId: string, allowUnregistered = false): CallerContext {
    invariant(providerSessionId, "SESSION_CONTEXT_REQUIRED", "Provider session identity is required for this operation");
    const caller = this.cells.callerByProviderSessionId(providerSessionId);
    if (caller) return { providerSessionId, sessionToken: caller.session_token };
    invariant(allowUnregistered, "CALLER_UNKNOWN", "Caller provider session is not registered in SIDMAH");
    return { providerSessionId, sessionToken: randomUUID() };
  }

  startDirector(context: CallerContext) {
    return this.cells.startDirector(context.providerSessionId, context.sessionToken);
  }

  async createCell(context: CallerContext, meaning: unknown, existingCellNo?: number) {
    const output = await this.cells.createCellAssignment(context.sessionToken, meaning, existingCellNo);
    await this.pump(); return output;
  }
  async acceptCell(context: CallerContext, unregistered = false, assignmentId?: string) {
    const output = unregistered ? this.cells.claimPendingCellAssignment(context.providerSessionId, assignmentId) : (this.cells.acknowledgeCellAssignment(context.sessionToken, assignmentId), { ok: true });
    await this.pump(); return output;
  }
  async createStart(context: CallerContext, cellNo: number, meaning: unknown, timeoutMs?: number) {
    const output = this.runtimes.createStartAssignment(context.sessionToken, cellNo, meaning, timeoutMs);
    await this.pump(); return { ...output, ...this.pendingDeliveries(context) };
  }

  /** Read only current, scoped inbox slots; never claim or acknowledge on a poll. */
  pendingDeliveries(context: CallerContext) {
    const caller = this.cells.caller(context.sessionToken);
    invariant(caller.status === "active", "CALLER_NOT_ACTIVE", "Caller session is not active");
    invariant(caller.provider_session_id === context.providerSessionId, "CALLER_CONTEXT_MISMATCH", "Caller identity does not match session");
    const rows = this.cells.db.prepare(`SELECT i.* FROM worker_slots s
      JOIN worker_inbox i ON i.item_id=s.item_id
      JOIN workers w ON w.worker_id=i.worker_id AND w.status='active'
      JOIN bindings b ON b.worker_id=w.worker_id AND b.cell_no=i.cell_no AND b.status='current'
      WHERE w.run_id=? AND s.session_id=w.provider_session_id AND i.session_id=s.session_id
        AND s.phase='submitted' AND i.state='submitted' AND i.kind IN('start','result')
        AND (?='director' OR w.worker_id=?) ORDER BY i.priority,i.created_at`).all(caller.run_id, caller.kind, caller.worker_id) as any[];
    const deliveries: (ProviderDeliveryRequest & { message: string; cellNo?: number })[] = rows.map(row => {
      const request: ProviderDeliveryRequest = { deliveryId: row.delivery_id, providerSessionId: row.session_id, kind: row.kind, payload: JSON.parse(row.payload_json) };
      return { ...request, cellNo: row.cell_no, message: deliveryMessage(request) };
    });
    if (caller.kind === "director") {
      const ends = this.runtimes.db.prepare(`SELECT i.* FROM director_slots s JOIN director_inbox i ON i.item_id=s.item_id
        WHERE s.run_id=? AND s.phase='submitted' AND i.state='submitted'
          AND i.target_run_id=? AND i.target_provider_session_id=?`).all(caller.run_id, caller.run_id, context.providerSessionId) as any[];
      for (const row of ends) {
        const request: ProviderDeliveryRequest = { deliveryId: row.delivery_id, providerSessionId: row.target_provider_session_id, kind: "end", payload: JSON.parse(row.payload_json) };
        deliveries.push({ ...request, message: deliveryMessage(request) });
      }
    }
    return { deliveryMode: deliveryMode(this.root), deliveries };
  }

  async getPendingDeliveries(context: CallerContext) {
    const caller = this.cells.caller(context.sessionToken);
    invariant(caller.status === "active", "CALLER_NOT_ACTIVE", "Caller session is not active");
    invariant(caller.provider_session_id === context.providerSessionId, "CALLER_CONTEXT_MISMATCH", "Caller identity does not match session");
    await this.pump();
    return this.pendingDeliveries(context);
  }
  async starter(context: CallerContext) { const output = await this.runtimes.starter(context.sessionToken); await this.pump(); return output; }
  async createEnd(context: CallerContext, meaning: unknown) { const output = this.runtimes.createEndAssignment(context.sessionToken, meaning); await this.pump(); return output; }
  async completeEndReview(context: CallerContext) { const output = this.runtimes.completeEndReview(context.sessionToken); await this.pump(); return output; }
  async endDirector(context: CallerContext) {
    const output = await this.cells.endDirector(context.sessionToken);
    this.runtimes.releaseDirectorRun(output.runId);
    return output;
  }

  async providerSessionEnded(providerSessionId: string, reason: string): Promise<void> {
    const director = this.cells.activeDirectorByProviderId(providerSessionId);
    if (director) { await this.endDirector({ providerSessionId, sessionToken: director.sessionToken }); return; }
    await this.cells.endWorkerSessionByProviderId(providerSessionId, reason);
  }

  async pump(): Promise<void> {
    this.runtimes.drainWorkerDispatch();
    for (const cellNo of this.cells.currentBoundCellNumbers()) {
      try { await this.cells.dispatchNextForCell(cellNo); }
      catch (error) { this.cells.log.write("worker_delivery_failed", { cellNo, error: String(error) }); }
    }
    try { await this.runtimes.dispatchNextDirector(); }
    catch (error) { this.runtimes.log.write("director_delivery_failed", { error: String(error) }); }
  }
  async recover(): Promise<void> { await this.cells.recover(); await this.runtimes.recover(); }
  close(): void { this.runtimes.close(); this.cells.close(); }
}

export function environmentProviderSessionId(): string | undefined {
  return process.env.SIDMAH_PROVIDER_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
}

export function providerSessionIdFromRequestMeta(meta: unknown): string | undefined {
  if (meta && typeof meta === "object" && typeof (meta as any).threadId === "string" && (meta as any).threadId.trim()) return (meta as any).threadId.trim();
  return environmentProviderSessionId();
}

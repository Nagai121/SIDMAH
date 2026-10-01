import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { invariant } from "./core/errors.ts";
import type { ProviderHarness } from "./core/types.ts";
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
    await this.pump(); return output;
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

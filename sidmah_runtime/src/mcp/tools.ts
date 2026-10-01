import { invariant } from "../core/errors.ts";
import type { CallerContext, SidmahSystem } from "../system.ts";
import { providerSessionIdFromRequestMeta } from "../system.ts";
import type { StdioMcpServer } from "./jsonrpc.ts";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 }, integer = { type: "integer", minimum: 1 };
const cell = object({ responsibility: string }, ["responsibility"]);
const start = object({ objective: string, targetAndConditions: string, method: string, observations: string, evaluation: string }, ["objective", "targetAndConditions", "method", "observations", "evaluation"]);
const end = object({ observedResults: string, outputAudit: string, hypothesisJudgement: string, reliabilityAndAnomalies: string, discussion: string, references: string }, ["observedResults", "outputAudit", "hypothesisJudgement", "reliabilityAndAnomalies", "discussion", "references"]);

type SystemProvider = () => Promise<SidmahSystem>;

function providerId(meta: unknown): string {
  const id = providerSessionIdFromRequestMeta(meta);
  invariant(id, "SESSION_CONTEXT_REQUIRED", "This SIDMAH tool requires Codex thread identity in tools/call _meta or an explicit provider session environment fallback");
  return id;
}

async function context(getSystem: SystemProvider, meta: unknown, allowUnregistered = false): Promise<{ system: SidmahSystem; context: CallerContext }> {
  const system = await getSystem();
  return { system, context: system.contextForProviderSession(providerId(meta), allowUnregistered) };
}

export function registerTools(server: StdioMcpServer, getSystem: SystemProvider): void {
  server.register({ name: "get_pending_deliveries", description: "Poll durable submitted deliveries without claiming them. In collaboration mode the Director relays returned Worker messages using native followup_task, and reviews its own End deliveries. Workers may inspect only their own deliveries. Polling is not processing-started proof.", inputSchema: object({}), call: async (_a, meta) => { const x = await context(getSystem, meta); return x.system.getPendingDeliveries(x.context); } });
  server.register({ name: "director_start", description: "Start a new SIDMAH Director run using the caller thread identity supplied by the MCP client.", inputSchema: object({}), call: async (_a, meta) => { const x = await context(getSystem, meta, true); return x.system.startDirector(x.context); } });
  server.register({ name: "create_cell_assignment", description: "Persist Cell and Binding state and return a Worker launch specification to the Director. SIDMAH does not spawn the Worker.", inputSchema: object({ meaning: cell, existingCellNo: integer }, ["meaning"]), call: async (a, meta) => { const x = await context(getSystem, meta); return x.system.createCell(x.context, a.meaning, a.existingCellNo); } });
  server.register({ name: "create_start_assignment", description: "Persist one Start and Runtime, then enqueue it through the Cell-owned Worker inbox. Omit timeoutMs unless the user specified a time limit; omission means no time limit.", inputSchema: object({ cellNo: integer, meaning: start, timeoutMs: integer }, ["cellNo", "meaning"]), call: async (a, meta) => { const x = await context(getSystem, meta); return x.system.createStart(x.context, a.cellNo, a.meaning, a.timeoutMs); } });
  server.register({ name: "complete_end_review", description: "Complete the one active End review and release the next Director inbox item.", inputSchema: object({}), call: async (_a, meta) => { const x = await context(getSystem, meta); return x.system.completeEndReview(x.context); } });
  server.register({ name: "director_end", description: "End this Director run and its Worker sessions without stopping running Runtimes.", inputSchema: object({}), call: async (_a, meta) => { const x = await context(getSystem, meta); return x.system.endDirector(x.context); } });
  server.register({ name: "accept_cell_assignment", description: "Claim the pending Cell Assignment identified by the assignmentId supplied in the Worker bootstrap. Omission supports only a unique pending assignment.", inputSchema: object({ assignmentId: string }), call: async (a, meta) => { const x = await context(getSystem, meta, true); const registered = x.system.cells.callerByProviderSessionId(x.context.providerSessionId); return x.system.acceptCell(x.context, !registered, a.assignmentId); } });
  server.register({ name: "starter", description: "Atomically fix the active Start Snapshot and hand its Runtime to an independent executor.", inputSchema: object({}), call: async (_a, meta) => { const x = await context(getSystem, meta); return x.system.starter(x.context); } });
  server.register({ name: "create_end_assignment", description: "Create End meaning for the caller's one active Result context; Runtime identity is machine-resolved.", inputSchema: object({ meaning: end }, ["meaning"]), call: async (a, meta) => { const x = await context(getSystem, meta); return x.system.createEnd(x.context, a.meaning); } });
}

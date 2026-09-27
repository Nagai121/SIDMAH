import { invariant } from "./errors.ts";
import type { CellMeaning, EndMeaning, StartMeaning } from "./types.ts";

function exactObject(value: unknown, keys: string[], code: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), code, "Meaning must be an object");
  const object = value as Record<string, unknown>;
  invariant(Object.keys(object).sort().join("|") === [...keys].sort().join("|"), code, `Meaning must contain exactly: ${keys.join(", ")}`);
  for (const key of keys) invariant(typeof object[key] === "string" && (object[key] as string).trim().length > 0, code, `${key} must be a non-empty string`);
  return object;
}

export function cellMeaning(value: unknown): CellMeaning {
  return exactObject(value, ["responsibility"], "CELL_SCHEMA_INVALID") as unknown as CellMeaning;
}
export function startMeaning(value: unknown): StartMeaning {
  return exactObject(value, ["objective", "targetAndConditions", "method", "observations", "evaluation"], "START_SCHEMA_INVALID") as unknown as StartMeaning;
}
export function endMeaning(value: unknown): EndMeaning {
  return exactObject(value, ["observedResults", "outputAudit", "hypothesisJudgement", "reliabilityAndAnomalies", "discussion", "references"], "END_SCHEMA_INVALID") as unknown as EndMeaning;
}

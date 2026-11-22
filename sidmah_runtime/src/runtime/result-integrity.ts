// Verify an already-fixed Result without relying on delivery or Runtime manager state.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type VerifiedResult = {
  resultRef: string;
  resultHash: string;
  manifestRef: string;
  executionStatus: string;
};

export function readVerifiedResult(runtimeDirectory: string, runtimeId: string): VerifiedResult | undefined {
  const resultRef = resolve(runtimeDirectory, "result.json");
  const manifestRef = resolve(runtimeDirectory, "result.manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestRef, "utf8"));
    const body = readFileSync(resultRef, "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    const result = JSON.parse(body);
    if (manifest.complete === true && manifest.runtimeId === runtimeId && manifest.resultHash === hash) {
      return { resultRef, resultHash: hash, manifestRef, executionStatus: String(result.executionStatus) };
    }
  } catch { /* Missing or corrupt artifacts are not valid Results. */ }
  return undefined;
}

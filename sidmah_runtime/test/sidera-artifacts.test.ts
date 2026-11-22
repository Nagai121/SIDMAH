import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeFixedResult } from "../src/runtime/pipeline.ts";
import { readVerifiedResult } from "../src/runtime/result-integrity.ts";
import { runStarterPreflight, treeManifest, validateExperiment } from "../src/runtime/snapshot.ts";

function tempWorkspace(): { root: string; workspace: string; runtime: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-sidera-artifacts-"));
  const workspace = resolve(root, "work"), runtime = resolve(root, "runtime");
  mkdirSync(workspace); mkdirSync(runtime);
  return { root, workspace, runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("fixed Results can be verified without a Cell or a delivery context", () => {
  const x = tempWorkspace();
  try {
    const id = "independent-runtime";
    const written = writeFixedResult(x.runtime, id, { schemaVersion: 1, executionStatus: "success", stages: {} });
    const verified = readVerifiedResult(x.runtime, id);
    assert.equal(verified?.resultHash, written.resultHash);
    assert.equal(verified?.executionStatus, "success");
    assert.equal(readVerifiedResult(x.runtime, "different-runtime"), undefined);
    writeFileSync(written.resultRef, readFileSync(written.resultRef, "utf8") + " ", "utf8");
    assert.equal(readVerifiedResult(x.runtime, id), undefined);
  } finally { x.cleanup(); }
});

test("Snapshot contract rejects escaped command arguments", () => {
  const x = tempWorkspace();
  try {
    const contract = { starter: [process.execPath, "../outside"], simulator: [process.execPath], finisher: [process.execPath] };
    writeFileSync(resolve(x.workspace, "experiment.json"), JSON.stringify(contract));
    assert.throws(() => validateExperiment(x.workspace));
  } finally { x.cleanup(); }
});

test("Snapshot preflight verifies a valid read-only copy independent of Manager", async () => {
  const x = tempWorkspace();
  try {
    const contract = {
      starter: [process.execPath, "starter.mjs"],
      simulator: [process.execPath, "starter.mjs"],
      finisher: [process.execPath, "starter.mjs"],
    };
    writeFileSync(resolve(x.workspace, "experiment.json"), JSON.stringify(contract));
    writeFileSync(resolve(x.workspace, "starter.mjs"), "if (process.env.SIDMAH_PREFLIGHT !== '1') process.exit(2);");
    const initial = treeManifest(x.workspace).hash;
    await runStarterPreflight(x.workspace, x.runtime, 10_000);
    assert.equal(treeManifest(x.workspace).hash, initial);
  } finally { x.cleanup(); }
});

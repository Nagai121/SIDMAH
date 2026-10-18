import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SidmahSystem, configuredProvider } from "../src/index.ts";
import { transaction } from "../src/core/db.ts";
import { exportStateDatabases } from "../src/maintenance/state-export.ts";

const meaning = { objective: "audit", targetAndConditions: "fixture", method: "fixture", observations: "fixture", evaluation: "fixture" };
async function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-integrated-"));
  writeFileSync(resolve(root, "worker-model.json"), JSON.stringify({ model: "gpt-5.6-luna", reasoning_effort: "low" }));
  const system = new SidmahSystem(root, configuredProvider(root));
  system.startDirector(system.contextForProviderSession("director", true));
  const director = system.contextForProviderSession("director");
  system.registerQuery(director, "original", "分子の収束と拡散、酢酸と水、揺らぎを評価する");
  const cell = await system.createCell(director, { responsibility: "fixture" });
  await system.acceptCell(system.contextForProviderSession("worker", true), true, cell.assignmentId);
  return { root, system, director, cell, cleanup: () => { system.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("failed Start leaves no Query link; integration failure cannot block a registered Query's Start", async () => {
  const x = await fixture();
  try {
    const k = x.system.knowledge!;
    x.system.runtimes.db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON starts BEGIN SELECT RAISE(ABORT,'injected Start failure'); END");
    await assert.rejects(x.system.createStart(x.director, x.cell.cellNo, meaning), /injected Start failure/);
    assert.equal(x.system.runtimes.db.prepare("SELECT COUNT(*) n FROM runtime_queries").get()!.n, 0);
    assert.equal(k.db.prepare("SELECT COUNT(*) n FROM runtime_queries").get()!.n, 0);
    x.system.runtimes.db.exec("DROP TRIGGER fail_start");
    k.db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON runtime_queries BEGIN SELECT RAISE(ABORT,'injected integration failure'); END");
    const start = await x.system.createStart(x.director, x.cell.cellNo, meaning);
    assert.equal(x.system.runtimes.db.prepare("SELECT revision_no FROM runtime_queries WHERE runtime_id=?").get(start.runtimeId)!.revision_no, 0);
    assert.throws(() => k.sync(), /injected integration failure/);
    // A new revision must not change the revision of the already committed Start.
    x.system.registerQuery(x.director, "revision", "改訂したQuery", 1);
    k.db.exec("DROP TRIGGER fail_link");
    k.sync();
    assert.equal(k.db.prepare("SELECT revision_no FROM runtime_queries WHERE runtime_id=?").get(start.runtimeId)!.revision_no, 0);
  } finally { x.cleanup(); }
});

test("registered Query survives restart when integrated DB cannot open", async () => {
  const x = await fixture();
  x.system.close();
  writeFileSync(resolve(x.root, "state", "integrated.sqlite"), "not a SQLite database");
  const reopened = new SidmahSystem(x.root, configuredProvider(x.root));
  try {
    assert.equal(reopened.knowledge, undefined);
    const start = await reopened.createStart(reopened.contextForProviderSession("director"), x.cell.cellNo, meaning);
    assert.equal(reopened.runtimes.db.prepare("SELECT query_no FROM runtime_queries WHERE runtime_id=?").get(start.runtimeId)!.query_no, 1);
  } finally { reopened.close(); rmSync(x.root, { recursive: true, force: true }); }
});

test("short Japanese MATCH uses substring search without changing parameters or SQL literals", async () => {
  const x = await fixture();
  try {
    const k = x.system.knowledge!;
    for (const term of ["収束", "拡散", "酢酸", "水", '"収束"', "揺らぎ"]) {
      const result = k.querySQL(k.sessionId, "SELECT content FROM search_fts WHERE search_fts MATCH ?", [term]);
      assert.equal(result.rows.length, 1, term);
    }
    assert.equal(k.querySQL(k.sessionId, "SELECT content FROM search_fts WHERE search_fts MATCH '収束'").rows.length, 1);
    assert.equal(k.querySQL(k.sessionId, 'SELECT content FROM search_fts WHERE "search_fts"."content" MATCH ? AND kind=?', ["収束", "query"]).rows.length, 1);
    assert.equal(k.querySQL(k.sessionId, "SELECT ? AS label, 'search_fts MATCH ?' AS literal FROM search_fts WHERE search_fts MATCH ? /* search_fts MATCH '水' */", ["label", "収束"]).rows[0].label, "label");
    assert.equal(k.querySQL(k.sessionId, "SELECT content FROM search_fts WHERE search_fts MATCH ?", ["不存在"]).rows.length, 0);
    assert.throws(() => k.querySQL(k.sessionId, "DELETE FROM query_revisions"), /SELECT/);
    assert.throws(() => k.querySQL(k.sessionId, "SELECT load_extension('not-allowed')"), /not authorized/);
    assert.throws(() => k.querySQL(k.sessionId, "SELECT * FROM pragma_writable_schema(1)"));
  } finally { x.cleanup(); }
});

test("close flushes a successful source COMMIT instead of discarding the pending sync", async () => {
  const x = await fixture();
  transaction(x.system.runtimes.db, () => x.system.runtimes.db.prepare("UPDATE sequence_counter SET value=99").run());
  x.system.close();
  const db = new DatabaseSync(resolve(x.root, "state", "integrated.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT value FROM runtime_sequence_counter").get()!.value, 99); }
  finally { db.close(); rmSync(x.root, { recursive: true, force: true }); }
});

test("v2.0.0 Query links migrate only for existing Runtimes and orphan links are removed", async () => {
  const x = await fixture();
  const start = await x.system.createStart(x.director, x.cell.cellNo, meaning);
  x.system.knowledge!.sync();
  x.system.runtimes.db.prepare("DELETE FROM runtime_queries").run();
  x.system.knowledge!.db.prepare("INSERT INTO runtime_queries VALUES('orphan',1,0,0)").run();
  x.system.close();
  const reopened = new SidmahSystem(x.root, configuredProvider(x.root));
  try {
    assert.equal(reopened.runtimes.db.prepare("SELECT query_no FROM runtime_queries WHERE runtime_id=?").get(start.runtimeId)!.query_no, 1);
    reopened.knowledge!.sync();
    assert.equal(reopened.knowledge!.db.prepare("SELECT COUNT(*) n FROM runtime_queries WHERE runtime_id='orphan'").get()!.n, 0);
  } finally { reopened.close(); rmSync(x.root, { recursive: true, force: true }); }
});

test("state export includes Query history from integrated.sqlite", async () => {
  const x = await fixture();
  try {
    x.system.knowledge!.sync();
    const files = await exportStateDatabases(x.root, resolve(x.root, "export"));
    assert.equal(files.length, 3);
    const db = new DatabaseSync(resolve(x.root, "export", "integrated.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM query_revisions").get()!.n, 1); }
    finally { db.close(); }
  } finally { x.cleanup(); }
});

test("concurrent initialization creates one session UUID", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "sidmah-identity-"));
  // Initialize the source schemas; the integrated DB itself starts absent.
  const initial = new SidmahSystem(root, configuredProvider(root)); initial.close();
  rmSync(resolve(root, "state", "integrated.sqlite"));
  const script = `import {SidmahSystem,configuredProvider} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}; const root=process.argv[1];const s=new SidmahSystem(root,configuredProvider(root));if(!s.knowledge)throw new Error('integration unavailable');console.log(s.knowledge.sessionId);s.close();`;
  try {
    const ids = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root]);
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      child.on("error", fail); child.on("exit", code => code === 0 ? done(stdout.trim()) : fail(new Error(stderr)));
    })));
    assert.equal(new Set(ids).size, 1);
    const db = new DatabaseSync(resolve(root, "state", "integrated.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM session_identity").get()!.n, 1); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

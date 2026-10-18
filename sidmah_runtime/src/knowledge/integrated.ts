import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, transaction } from "../core/db.ts";
import { invariant } from "../core/errors.ts";

type Row = Record<string, any>;
type Source = { prefix: "cell" | "runtime"; db: DatabaseSync };
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const pkKey = (parts: unknown[]) => JSON.stringify(parts);
const validUUID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

export class IntegratedStore {
  readonly db: DatabaseSync;
  readonly sessionId: string;
  private readonly sources: Source[];
  private readonly root: string;
  private syncing = false;
  private readonly sourceVersions = new Map<string, string>();

  constructor(root: string, cells: DatabaseSync, runtimes: DatabaseSync) {
    this.root = root;
    mkdirSync(resolve(root, "shared_databases"), { recursive: true });
    this.sources = [{ prefix: "cell", db: cells }, { prefix: "runtime", db: runtimes }];
    this.db = openDb(resolve(root, "state", "integrated.sqlite"));
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS session_identity(session_id TEXT PRIMARY KEY);",
      "CREATE TABLE IF NOT EXISTS query_revisions(query_no INTEGER NOT NULL,revision_no INTEGER NOT NULL,operation_key TEXT NOT NULL UNIQUE,content TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(query_no,revision_no));",
      "CREATE TABLE IF NOT EXISTS active_query(singleton INTEGER PRIMARY KEY CHECK(singleton=1),query_no INTEGER NOT NULL,revision_no INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS runtime_queries(runtime_id TEXT PRIMARY KEY,query_no INTEGER NOT NULL,revision_no INTEGER NOT NULL,created_at INTEGER NOT NULL);",
      "CREATE TABLE IF NOT EXISTS result_json(runtime_id TEXT PRIMARY KEY,result_hash TEXT NOT NULL,body TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS search_documents(kind TEXT NOT NULL,record_id TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(kind,record_id));",
      "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(kind UNINDEXED,record_id UNINDEXED,content,content='search_documents',content_rowid='rowid',tokenize='trigram');",
      "CREATE TRIGGER IF NOT EXISTS search_documents_ai AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,kind,record_id,content) VALUES(new.rowid,new.kind,new.record_id,new.content); END;",
      "CREATE TRIGGER IF NOT EXISTS search_documents_ad AFTER DELETE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,kind,record_id,content) VALUES('delete',old.rowid,old.kind,old.record_id,old.content); END;",
      "CREATE TRIGGER IF NOT EXISTS search_documents_au AFTER UPDATE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,kind,record_id,content) VALUES('delete',old.rowid,old.kind,old.record_id,old.content); INSERT INTO search_fts(rowid,kind,record_id,content) VALUES(new.rowid,new.kind,new.record_id,new.content); END;"
    ].join("\n"));
    let identity = this.db.prepare("SELECT session_id FROM session_identity LIMIT 1").get() as Row | undefined;
    if (!identity) {
      this.db.prepare("INSERT INTO session_identity(session_id) VALUES(?)").run(randomUUID());
      identity = this.db.prepare("SELECT session_id FROM session_identity LIMIT 1").get() as Row;
    }
    invariant(validUUID(String(identity.session_id)), "INVALID_SESSION_UUID", "Integrated DB must have a UUID v4 session identity");
    this.sessionId = String(identity.session_id);
  }

  private queryId(queryNo: number, revisionNo: number): string {
    return String(queryNo).padStart(3, "0") + "-" + String(revisionNo).padStart(3, "0");
  }

  registerQuery(operationKey: string, content: string, queryNo?: number) {
    invariant(typeof operationKey === "string" && operationKey.trim().length > 0, "QUERY_OPERATION_REQUIRED", "A stable registration operation key is required");
    invariant(typeof content === "string" && content.trim().length > 0, "QUERY_TEXT_REQUIRED", "The full Query text is required");
    invariant(queryNo === undefined || (Number.isSafeInteger(queryNo) && queryNo > 0), "QUERY_NUMBER_INVALID", "Query number must be a positive integer");
    const row = transaction(this.db, () => {
      const old = this.db.prepare("SELECT * FROM query_revisions WHERE operation_key=?").get(operationKey) as Row | undefined;
      if (old) {
        invariant(old.content === content && (queryNo === undefined || old.query_no === queryNo), "QUERY_OPERATION_CONFLICT", "Registration key already used for different contents");
        return old;
      }
      let n: number, revision: number;
      if (queryNo === undefined) {
        n = Number((this.db.prepare("SELECT COALESCE(MAX(query_no),0)+1 AS next FROM query_revisions").get() as Row).next);
        revision = 0;
      } else {
        invariant(this.db.prepare("SELECT 1 FROM query_revisions WHERE query_no=?").get(queryNo), "QUERY_NOT_FOUND", "Unknown Query cannot be revised");
        n = queryNo;
        revision = Number((this.db.prepare("SELECT COALESCE(MAX(revision_no),-1)+1 AS next FROM query_revisions WHERE query_no=?").get(n) as Row).next);
      }
      this.db.prepare("INSERT INTO query_revisions(query_no,revision_no,operation_key,content,created_at) VALUES(?,?,?,?,?)").run(n, revision, operationKey, content, Date.now());
      this.db.prepare("INSERT INTO active_query(singleton,query_no,revision_no) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET query_no=excluded.query_no,revision_no=excluded.revision_no").run(n, revision);
      this.index("query", this.queryId(n, revision), content);
      return { query_no: n, revision_no: revision };
    });
    return { sessionId: this.sessionId, queryId: this.queryId(row.query_no, row.revision_no), queryNo: row.query_no, revisionNo: row.revision_no };
  }

  currentQuery(): { queryNo: number; revisionNo: number } {
    const row = this.db.prepare("SELECT query_no,revision_no FROM active_query WHERE singleton=1").get() as Row | undefined;
    invariant(row, "QUERY_NOT_REGISTERED", "Register the agreed Query before creating Start");
    return { queryNo: row.query_no, revisionNo: row.revision_no };
  }

  bindRuntime(runtimeId: string): void {
    const query = this.currentQuery();
    transaction(this.db, () => {
      const old = this.db.prepare("SELECT query_no,revision_no FROM runtime_queries WHERE runtime_id=?").get(runtimeId) as Row | undefined;
      if (old) {
        invariant(old.query_no === query.queryNo && old.revision_no === query.revisionNo, "RUNTIME_QUERY_CONFLICT", "Runtime Query revision cannot change");
        return;
      }
      this.db.prepare("INSERT INTO runtime_queries(runtime_id,query_no,revision_no,created_at) VALUES(?,?,?,?)").run(runtimeId, query.queryNo, query.revisionNo, Date.now());
    });
  }

  private index(kind: string, id: string, content: string): void {
    this.db.prepare("INSERT INTO search_documents(kind,record_id,content) VALUES(?,?,?) ON CONFLICT(kind,record_id) DO UPDATE SET content=excluded.content WHERE content<>excluded.content").run(kind, id, content);
  }

  private mirrorTable(source: Source, table: string): Row[] {
    const target = source.prefix + "_" + table;
    const row = source.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as Row | undefined;
    invariant(row?.sql, "SOURCE_SCHEMA_INVALID", "Missing source table " + table);
    const create = String(row.sql).replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|\[[^\]]+\]|[a-zA-Z_][a-zA-Z_0-9]*)/i, "CREATE TABLE IF NOT EXISTS " + quote(target));
    invariant(create !== row.sql, "SOURCE_SCHEMA_INVALID", "Cannot replicate " + table);
    this.db.exec(create);
    const columns = (source.db.prepare("PRAGMA table_info(" + quote(table) + ")").all() as Row[]).map(x => ({ name: String(x.name), type: String(x.type || "TEXT"), pk: Number(x.pk) }));
    const existing = new Set((this.db.prepare("PRAGMA table_info(" + quote(target) + ")").all() as Row[]).map(x => String(x.name)));
    for (const c of columns) if (!existing.has(c.name)) this.db.exec("ALTER TABLE " + quote(target) + " ADD COLUMN " + quote(c.name) + " " + c.type);
    const fields = columns.map(x => x.name);
    const pk = columns.filter(x => x.pk > 0).sort((a, b) => a.pk - b.pk).map(x => x.name);
    invariant(pk.length > 0, "SOURCE_SCHEMA_INVALID", "Missing source primary key in " + table);
    const data = source.db.prepare("SELECT * FROM " + quote(table)).all() as Row[];
    const nonkeys = fields.filter(x => !pk.includes(x));
    const base = "INSERT INTO " + quote(target) + "(" + fields.map(quote).join(",") + ") VALUES(" + fields.map(() => "?").join(",") + ")";
    const upsert = nonkeys.length ? base + " ON CONFLICT DO UPDATE SET " +
      nonkeys.map(x => quote(x) + "=excluded." + quote(x)).join(",") + " WHERE " +
      nonkeys.map(x => quote(target) + "." + quote(x) + " IS NOT excluded." + quote(x)).join(" OR ") : base.replace("INSERT INTO", "INSERT OR IGNORE INTO");
    const insert = this.db.prepare(upsert);
    const seen = new Set<string>();
    for (const v of data) {
      insert.run(...fields.map(x => v[x]));
      seen.add(pkKey(pk.map(x => v[x])));
    }
    const existingRows = this.db.prepare("SELECT " + pk.map(quote).join(",") + " FROM " + quote(target)).all() as Row[];
    const remove = this.db.prepare("DELETE FROM " + quote(target) + " WHERE " + pk.map(x => quote(x) + "=?").join(" AND "));
    for (const v of existingRows) if (!seen.has(pkKey(pk.map(x => v[x])))) remove.run(...pk.map(x => v[x]));
    return data;
  }

  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const versions = this.sources.map(source => {
        const changes = (source.db.prepare("SELECT total_changes() AS n").get() as Row).n;
        const dataVersion = (source.db.prepare("PRAGMA data_version").get() as Row).data_version;
        return source.prefix + ":" + changes + ":" + dataVersion;
      });
      transaction(this.db, () => {
        for (const [index, source] of this.sources.entries()) {
          if (this.sourceVersions.get(source.prefix) === versions[index]) continue;
          const names = (source.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map(x => String(x.name));
          for (const table of names) this.mirrorTable(source, table);
        }
        const original = this.sources[1].db;
        const starts = original.prepare("SELECT start_id,meaning_json FROM starts").all() as Row[];
        const ends = original.prepare("SELECT runtime_id,meaning_json FROM ends WHERE meaning_json IS NOT NULL").all() as Row[];
        for (const x of starts) this.index("start", x.start_id, x.meaning_json);
        for (const x of ends) this.index("end", x.runtime_id, x.meaning_json);
        for (const group of [{ kind: "start", rows: starts, id: "start_id" }, { kind: "end", rows: ends, id: "runtime_id" }]) {
          const seen = new Set(group.rows.map(x => x[group.id]));
          const old = this.db.prepare("SELECT record_id FROM search_documents WHERE kind=?").all(group.kind) as Row[];
          for (const row of old) if (!seen.has(row.record_id)) this.db.prepare("DELETE FROM search_documents WHERE kind=? AND record_id=?").run(group.kind, row.record_id);
        }
        const outputs = original.prepare("SELECT runtime_id,result_ref,result_hash FROM runtimes WHERE result_ref IS NOT NULL AND result_hash IS NOT NULL").all() as Row[];
        const works = resolve(this.root, "works");
        if (existsSync(works)) {
          const permitted = realpathSync(works);
          for (const row of outputs) {
            if ((this.db.prepare("SELECT result_hash FROM result_json WHERE runtime_id=?").get(row.runtime_id) as Row | undefined)?.result_hash === row.result_hash) continue;
            try {
              const path = realpathSync(String(row.result_ref));
              const rel = relative(permitted, path);
              if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || basename(path) !== "result.json") continue;
              const body = readFileSync(path, "utf8");
              const hash = createHash("sha256").update(body).digest("hex");
              if (hash !== row.result_hash) continue;
              this.db.prepare("INSERT INTO result_json(runtime_id,result_hash,body) VALUES(?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET result_hash=excluded.result_hash,body=excluded.body").run(row.runtime_id, hash, body);
              this.index("result", row.runtime_id, body);
            } catch { /* Missing or incomplete results remain eligible for later synchronization. */ }
          }
        }
      });
      for (const [index, source] of this.sources.entries()) this.sourceVersions.set(source.prefix, versions[index]);
    } finally { this.syncing = false; }
  }

  rebuildIndex(): void { this.db.prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')").run(); }

  private available() {
    const current = resolve(this.root, "state", "integrated.sqlite");
    const paths = new Map([[this.sessionId, current]]);
    const sessions = [{ sessionId: this.sessionId, origin: "current", fileName: basename(current) }];
    const duplicates = new Set<string>();
    const shared = resolve(this.root, "shared_databases");
    if (existsSync(shared)) for (const entry of readdirSync(shared, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
      let connection: DatabaseSync | undefined;
      const path = resolve(shared, entry.name);
      try {
        connection = new DatabaseSync(path, { readOnly: true, allowExtension: false });
        const identity = connection.prepare("SELECT session_id FROM session_identity LIMIT 1").get() as Row | undefined;
        const id = String(identity?.session_id ?? "");
        if (!validUUID(id)) continue;
        if (paths.has(id)) { duplicates.add(id); if (id !== this.sessionId) paths.delete(id); }
        else if (!duplicates.has(id)) {
          paths.set(id, path);
          sessions.push({ sessionId: id, origin: "external", fileName: entry.name });
        }
      } catch { /* Invalid or incomplete shared DBs are not selectable. */ }
      finally { connection?.close(); }
    }
    return { sessions: sessions.filter(x => !duplicates.has(x.sessionId) || x.origin === "current"), duplicates: [...duplicates], paths };
  }

  listSessions() {
    const { sessions, duplicates } = this.available();
    return { sessions, duplicates };
  }

  querySQL(sessionId: string, sql: string, parameters: Array<string | number | null> = []) {
    invariant(typeof sessionId === "string" && validUUID(sessionId), "SESSION_ID_INVALID", "Valid session UUID required");
    invariant(typeof sql === "string" && sql.length <= 20000 && /^\s*(SELECT|WITH)\b/i.test(sql), "SQL_READ_ONLY_REQUIRED", "Only SELECT/WITH SQL is accepted");
    invariant(Array.isArray(parameters) && parameters.length <= 100 && parameters.every(x => x === null || typeof x === "string" || (typeof x === "number" && Number.isFinite(x))), "SQL_PARAMETERS_INVALID", "Only bounded scalar parameters are supported");
    if (sessionId === this.sessionId) this.sync();
    const path = this.available().paths.get(sessionId);
    invariant(path, "SESSION_NOT_AVAILABLE", "Session unavailable or duplicate UUID detected");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", resolve(import.meta.dirname, "sql-reader.ts"), path], {
      input: JSON.stringify({ sql, parameters }), encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true
    });
    invariant(!run.error && run.status === 0, "SQL_QUERY_FAILED", (run.stderr || run.error?.message || "Query exceeded time or output limit").slice(0, 800));
    return JSON.parse(run.stdout);
  }

  close(): void { this.db.close(); }
}

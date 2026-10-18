import { readFileSync } from "node:fs";
import { DatabaseSync, constants } from "node:sqlite";

const file = process.argv[2];
let db: DatabaseSync | undefined;
try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  if (!file || typeof request.sql !== "string" || !/^\s*(SELECT|WITH)\b/i.test(request.sql)) throw new Error("SELECT/WITH SQL required");
  db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 1000 });
  if (typeof db.setAuthorizer !== "function") throw new Error("Node.js >=24.10 required for SQL authorization");
  const allowed = new Set([constants.SQLITE_READ, constants.SQLITE_SELECT, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
  db.setAuthorizer((action: number, arg1: string | null, arg2: string | null) => {
    // FTS5 checks PRAGMA data_version internally. This PRAGMA only reads a version counter.
    if (action === constants.SQLITE_PRAGMA && arg1 === "data_version" && arg2 === null) return constants.SQLITE_OK;
    return allowed.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY;
  });
  const sql = request.sql.trim().replace(/;\s*$/, "");
  const statement = db.prepare("SELECT * FROM (" + sql + ") LIMIT 201");
  const rows = statement.all(...request.parameters);
  process.stdout.write(JSON.stringify({ rows: rows.slice(0, 200), truncated: rows.length > 200 }) + "\n");
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
} finally { db?.close(); }

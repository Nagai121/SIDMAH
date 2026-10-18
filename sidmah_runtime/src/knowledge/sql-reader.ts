import { readFileSync } from "node:fs";
import { DatabaseSync, constants } from "node:sqlite";

const file = process.argv[2];

// FTS5 trigram cannot index one/two-character terms. Preserve literal substring
// semantics for these MATCH operands, including Japanese, using SQLite LIKE.
// Tokenize SQL so literals/comments and repeated parameters are never rewritten.
function shortMatchSQL(sql: string, parameters: Array<string | number | null>): string {
  const tokens: Array<{ text: string; start: number; end: number; parameter?: number }> = [];
  const lexer = /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\?\d*|[\p{L}\p{N}_$]+|./gu;
  let nextParameter = 0;
  for (const match of sql.matchAll(lexer)) {
    const text = match[0];
    if (/^\s|^--|^\/\*/.test(text)) continue;
    const token: typeof tokens[number] = { text, start: match.index!, end: match.index! + text.length };
    if (text.startsWith("?")) {
      token.parameter = text.length > 1 ? Number(text.slice(1)) - 1 : nextParameter;
      nextParameter = Math.max(nextParameter, token.parameter + 1);
    }
    tokens.push(token);
  }
  const name = (text: string) => text.replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 1; i + 1 < tokens.length; i++) {
    if (tokens[i].text.toUpperCase() !== "MATCH") continue;
    const left = tokens[i - 1], right = tokens[i + 1];
    const tableMatch = name(left.text) === "search_fts";
    const contentMatch = name(left.text) === "content" && tokens[i - 2]?.text === "." && name(tokens[i - 3]?.text ?? "") === "search_fts";
    if (!tableMatch && !contentMatch) continue;
    let value = right.parameter === undefined ? (right.text.startsWith("'") ? right.text.slice(1, -1).replaceAll("''", "'") : undefined) : parameters[right.parameter];
    if (typeof value !== "string") continue;
    // A quoted FTS phrase also denotes a literal term. Operators are left to FTS5.
    if (/^"(?:""|[^"])*"$/.test(value)) value = value.slice(1, -1).replaceAll('""', '"');
    if (!/^[\p{L}\p{N}]{1,2}$/u.test(value)) continue;
    if (tableMatch) replacements.push({ start: left.end, end: left.end, text: ".content" });
    replacements.push({ start: tokens[i].start, end: right.end, text: "LIKE ('%' || trim(" + right.text + ", '\"') || '%')" });
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, replacement.start) + replacement.text + sql.slice(replacement.end);
  }
  return sql;
}

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
  const sql = shortMatchSQL(request.sql.trim().replace(/;\s*$/, ""), request.parameters);
  const statement = db.prepare("SELECT * FROM (" + sql + ") LIMIT 201");
  const rows = statement.all(...request.parameters);
  process.stdout.write(JSON.stringify({ rows: rows.slice(0, 200), truncated: rows.length > 200 }) + "\n");
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
} finally { db?.close(); }

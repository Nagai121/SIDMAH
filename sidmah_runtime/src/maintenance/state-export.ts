import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { invariant } from "../core/errors.ts";

const DATABASES = ["cell_management.sqlite", "runtime_management.sqlite"] as const;

function integrity(db: DatabaseSync, label: string): void {
  const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
  invariant(row?.integrity_check === "ok", "DATABASE_INTEGRITY_FAILED", `${label} failed SQLite integrity_check`);
}

function checkpoint(db: DatabaseSync, label: string): void {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown> | undefined;
  invariant(Number(row?.busy ?? 1) === 0, "DATABASE_CHECKPOINT_BUSY", `${label} WAL checkpoint could not obtain a complete checkpoint`);
}

export async function exportStateDatabases(root: string, destination: string): Promise<string[]> {
  const stateRoot = resolve(root, "state");
  mkdirSync(destination, { recursive: true });
  const outputs: string[] = [];
  for (const name of DATABASES) {
    const source = resolve(stateRoot, name);
    invariant(existsSync(source), "DATABASE_NOT_FOUND", `${name} does not exist`);
    const db = new DatabaseSync(source);
    db.exec("PRAGMA busy_timeout=5000;");
    const final = resolve(destination, name), temporary = `${final}.${process.pid}.tmp`;
    try {
      checkpoint(db, name);
      integrity(db, name);
      rmSync(temporary, { force: true });
      rmSync(final, { force: true });
      await backup(db, temporary);
      const exported = new DatabaseSync(temporary, { readOnly: true });
      try { integrity(exported, `${name} export`); } finally { exported.close(); }
      renameSync(temporary, final);
      outputs.push(final);
    } finally {
      rmSync(temporary, { force: true });
      db.close();
    }
  }
  return outputs;
}

const [rootArg, destinationArg] = process.argv.slice(2);
if (rootArg && destinationArg && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputs = await exportStateDatabases(resolve(rootArg), resolve(destinationArg));
  process.stdout.write(`${JSON.stringify({ exported: outputs }, null, 2)}\n`);
}

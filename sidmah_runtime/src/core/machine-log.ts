import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class MachineLog {
  private readonly path: string;
  constructor(path: string) { this.path = path; mkdirSync(dirname(path), { recursive: true }); }
  write(event: string, details: Record<string, unknown> = {}): void {
    try { appendFileSync(this.path, JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + "\n", "utf8"); } catch {}
  }
}

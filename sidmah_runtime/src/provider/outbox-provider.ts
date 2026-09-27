import { mkdirSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderDeliveryRequest, ProviderHarness } from "../core/types.ts";

function atomicJson(path: string, value: unknown): void {
  if (existsSync(path)) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try { renameSync(temporary, path); } catch (error) { if (!existsSync(path)) throw error; rmSync(temporary, { force: true }); }
}

export class OutboxProvider implements ProviderHarness {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    for (const name of ["delivery", "terminate"]) mkdirSync(resolve(root, name), { recursive: true });
  }
  async deliver(request: ProviderDeliveryRequest) {
    atomicJson(resolve(this.root, "delivery", `${request.deliveryId}.json`), request);
    return { accepted: true, processingStarted: false };
  }
  async terminate(providerSessionId: string, reason: string): Promise<void> {
    const id = Buffer.from(providerSessionId).toString("base64url");
    atomicJson(resolve(this.root, "terminate", `${id}.json`), { providerSessionId, reason });
  }
}

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
export type QueueMessage = (threadId: string, message: string) => Promise<void>;
export type WakeThread = (threadId: string) => Promise<void>;

/** Queue to the existing Codex task; the receiving MCP call is the processing-started proof. */
export async function queueCodexMessage(threadId: string, message: string): Promise<void> {
  const command = process.env.SIDMAH_CODEX_CLI ?? "codex";
  const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  await execFileAsync(command, ["queue", "--thread", threadId, "--message", message], {
    env: { ...process.env, CODEX_HOME: codexHome },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

/** Resume a queued thread on the same local app-server used by `codex queue`. */
export interface CodexProxyTransport {
  input: Writable;
  output: Readable;
  close(): void;
  onFailure(handler: (error: Error) => void): void;
}

export function openCodexProxy(): CodexProxyTransport {
  const command = process.env.SIDMAH_CODEX_CLI ?? "codex";
  const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), ".codex");
  const child = spawn(command, ["app-server", "proxy"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout) throw new Error("Codex app-server proxy pipes are unavailable");
  return {
    input: child.stdin,
    output: child.stdout,
    close: () => { child.stdin?.end(); if (!child.killed) child.kill(); },
    onFailure: handler => {
      child.on("error", handler);
      child.on("exit", code => { if (code !== 0) handler(new Error(`Codex app-server proxy exited with code ${code}`)); });
    },
  };
}

export function wakeCodexThread(threadId: string, openProxy: () => CodexProxyTransport = openCodexProxy): Promise<void> {
  return new Promise((resolveWake, rejectWake) => {
    let proxy: CodexProxyTransport;
    try { proxy = openProxy(); }
    catch (error) { rejectWake(error); return; }
    let buffered = Buffer.alloc(0), upgraded = false, settled = false;
    const timeout = setTimeout(() => finish(new Error("Codex app-server resume timed out")), 15_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proxy.close();
      if (error) rejectWake(error); else resolveWake();
    };
    const send = (value: unknown) => {
      const payload = Buffer.from(JSON.stringify(value), "utf8"), mask = randomBytes(4);
      const header = payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0xfe, (payload.length >>> 8) & 0xff, payload.length & 0xff]);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      proxy.input.write(Buffer.concat([header, mask, masked]));
    };
    const onMessage = (value: any) => {
      if (value?.id === 1) {
        if (value.error) return finish(new Error(`Codex initialize: ${value.error.message ?? JSON.stringify(value.error)}`));
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "thread/resume", params: { threadId } });
      } else if (value?.id === 2) {
        if (value.error) return finish(new Error(`Codex thread/resume: ${value.error.message ?? JSON.stringify(value.error)}`));
        if (value.result?.thread?.id !== threadId) return finish(new Error("Codex resumed a different thread"));
        finish();
      }
    };
    proxy.onFailure(error => finish(error));
    proxy.output.on("error", error => finish(error));
    proxy.output.on("end", () => { if (!settled) finish(new Error("Codex app-server closed before resume")); });
    proxy.output.on("data", chunk => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = buffered.subarray(0, end).toString("utf8");
        if (!/^HTTP\/1\.1 101\b/.test(status)) return finish(new Error(`Codex WebSocket upgrade failed: ${status.split("\r\n")[0]}`));
        upgraded = true;
        buffered = buffered.subarray(end + 4);
        send({ id: 1, method: "initialize", params: { clientInfo: { name: "sidmah", title: "SIDMAH", version: "5.0.0" } } });
      }
      while (buffered.length >= 2 && !settled) {
        const first = buffered[0], second = buffered[1], opcode = first & 0x0f;
        let length = second & 0x7f, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) {
          if (buffered.length < 10) return;
          const extended = buffered.readBigUInt64BE(2);
          if (extended > BigInt(8 * 1024 * 1024)) return finish(new Error("Codex frame too large"));
          length = Number(extended); offset = 10;
        }
        const masked = Boolean(second & 0x80);
        if (masked) offset += 4;
        if (buffered.length < offset + length) return;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffered[offset - 4 + i % 4];
        buffered = buffered.subarray(offset + length);
        if (opcode === 0x8) return finish(new Error("Codex WebSocket closed before resume"));
        if (opcode === 0x9) continue;
        if (opcode !== 0x1) continue;
        try { onMessage(JSON.parse(payload.toString("utf8"))); }
        catch (error) { return finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    const key = randomBytes(16).toString("base64");
    proxy.input.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}

export function deliveryMessage(request: ProviderDeliveryRequest): string {
  const ref = `state/provider-outbox/delivery/${request.deliveryId}.json`;
  if (request.kind === "start") return `SIDMAH Start delivery ${request.deliveryId}. Read ${ref} in the project workspace, then continue the assigned Start and call the SIDMAH starter tool. This is the existing assignment; do not create another Start.`;
  if (request.kind === "result") return `SIDMAH Result delivery ${request.deliveryId}. Read ${ref} and the referenced result.json, audit the existing Runtime, then submit its End with the SIDMAH create_end_assignment tool. Do not rerun the Runtime.`;
  if (request.kind === "end") return `SIDMAH End delivery ${request.deliveryId}. Read ${ref}, review the existing End and its evidence, then call SIDMAH complete_end_review. Do not create a duplicate Runtime.`;
  throw new Error(`Unsupported Codex queue delivery kind: ${request.kind}`);
}

export class CodexQueueProvider implements ProviderHarness {
  private readonly outbox: OutboxProvider;
  private readonly queue: QueueMessage;
  private readonly wake: WakeThread;
  private readonly root: string;
  constructor(root: string, queue: QueueMessage = queueCodexMessage, wake: WakeThread = wakeCodexThread) {
    this.root = root;
    this.outbox = new OutboxProvider(root);
    this.queue = queue;
    this.wake = wake;
    mkdirSync(resolve(root, "queued"), { recursive: true });
  }

  async deliver(request: ProviderDeliveryRequest) {
    // Keep the durable delivery record even if the Codex queue call fails.
    await this.outbox.deliver(request);
    const queued = resolve(this.root, "queued", `${request.deliveryId}.json`);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!existsSync(queued)) {
          await this.queue(request.providerSessionId, deliveryMessage(request));
          atomicJson(queued, { deliveryId: request.deliveryId, providerSessionId: request.providerSessionId, queuedAt: Date.now() });
        }
        await this.wake(request.providerSessionId);
        return { accepted: true, processingStarted: false };
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolveDelay => setTimeout(resolveDelay, 250 * attempt));
      }
    }
    throw lastError;
  }

  async redeliver(request: ProviderDeliveryRequest): Promise<void> {
    await this.outbox.deliver(request);
    let lastError: unknown;
    let queued = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!queued) {
          await this.queue(request.providerSessionId, deliveryMessage(request));
          queued = true;
        }
        await this.wake(request.providerSessionId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolveDelay => setTimeout(resolveDelay, 250 * attempt));
      }
    }
    throw lastError;
  }

  terminate(providerSessionId: string, reason: string): Promise<void> {
    return this.outbox.terminate(providerSessionId, reason);
  }
}

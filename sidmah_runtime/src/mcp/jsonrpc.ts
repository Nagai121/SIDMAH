import { createInterface } from "node:readline";
import { SidmahError } from "../core/errors.ts";

export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown>; call: (args: any, meta?: unknown) => unknown | Promise<unknown> };
export class StdioMcpServer {
  #tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void { this.#tools.set(tool.name, tool); }
  async start(): Promise<void> {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      let request: any;
      try { request = JSON.parse(line); } catch { this.write(null, undefined, { code: -32700, message: "Parse error" }); continue; }
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") { this.write(request.id ?? null, undefined, { code: -32600, message: "Invalid Request" }); continue; }
      if (request.id === undefined) continue;
      try {
        if (request.method === "initialize") this.write(request.id, { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "sidmah", version: "1.0.3" } });
        else if (request.method === "ping") this.write(request.id, {});
        else if (request.method === "tools/list") this.write(request.id, { tools: [...this.#tools.values()].map(({ call: _, ...tool }) => tool) });
        else if (request.method === "tools/call") {
          const tool = this.#tools.get(request.params?.name); if (!tool) throw new SidmahError("TOOL_NOT_AVAILABLE", "Tool is not available");
          const value = await tool.call(request.params?.arguments ?? {}, request.params?._meta);
          this.write(request.id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
        } else this.write(request.id, undefined, { code: -32601, message: "Method not found" });
      } catch (error) {
        const known = error instanceof SidmahError ? error : new SidmahError("INTERNAL", error instanceof Error ? error.message : String(error));
        this.write(request.id, undefined, { code: -32000, message: known.message, data: { code: known.code } });
      }
    }
  }
  private write(id: unknown, result?: unknown, error?: unknown): void { process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n"); }
}

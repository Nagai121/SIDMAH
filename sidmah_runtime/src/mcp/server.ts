import { resolve } from "node:path";
import { configuredProvider } from "../provider/configured-provider.ts";
import { SidmahSystem } from "../system.ts";
import { StdioMcpServer } from "./jsonrpc.ts";
import { registerTools } from "./tools.ts";

const root = resolve(process.argv[2] ?? process.cwd());
const provider = configuredProvider(root);
let liveSystem: SidmahSystem | undefined;
let initializing: Promise<SidmahSystem> | undefined;

async function getSystem(): Promise<SidmahSystem> {
  if (liveSystem) return liveSystem;
  if (!initializing) {
    initializing = (async () => {
      const candidate = new SidmahSystem(root, provider);
      try {
        await candidate.recover();
        liveSystem = candidate;
        return candidate;
      } catch (error) {
        candidate.close();
        throw error;
      }
    })().finally(() => { if (!liveSystem) initializing = undefined; });
  }
  return initializing;
}

const server = new StdioMcpServer();
registerTools(server, getSystem);
await server.start();
liveSystem?.close();

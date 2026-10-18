import { configuredProvider } from "../provider/configured-provider.ts";
import { SidmahSystem } from "../system.ts";

const [root, runtimeId, token] = process.argv.slice(2);
if (!root || !runtimeId || !token) throw new Error("Usage: executor <root> <runtimeId> <executorToken>");
const provider = configuredProvider(root);
const system = new SidmahSystem(root, provider);
try { await system.runtimes.executeClaimed(runtimeId, token); }
finally { system.close(); }

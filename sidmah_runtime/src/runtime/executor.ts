import { configuredProvider } from "../provider/configured-provider.ts";
import { CellManager } from "../manager/cell-manager.ts";
import { RuntimeManager } from "../manager/runtime-manager.ts";

const [root, runtimeId, token] = process.argv.slice(2);
if (!root || !runtimeId || !token) throw new Error("Usage: executor <root> <runtimeId> <executorToken>");
const provider = configuredProvider(root);
const cells = new CellManager(root, provider);
const runtimes = new RuntimeManager(root, cells, provider);
await runtimes.executeClaimed(runtimeId, token);

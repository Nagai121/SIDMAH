import { CodexQueueProvider } from "../provider/outbox-provider.ts";
import { CellManager } from "../manager/cell-manager.ts";
import { RuntimeManager } from "../manager/runtime-manager.ts";
import { resolve } from "node:path";

const [root, runtimeId, token] = process.argv.slice(2);
if (!root || !runtimeId || !token) throw new Error("Usage: executor <root> <runtimeId> <executorToken>");
const provider = new CodexQueueProvider(resolve(root, "state", "provider-outbox"));
const cells = new CellManager(root, provider);
const runtimes = new RuntimeManager(root, cells, provider);
await runtimes.executeClaimed(runtimeId, token);

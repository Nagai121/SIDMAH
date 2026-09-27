import { resolve } from "node:path";
import { OutboxProvider } from "./outbox-provider.ts";
import { SidmahSystem } from "../system.ts";

const [rootArg, event, id, value] = process.argv.slice(2);
if (!rootArg || !event || !id) throw new Error("Usage: events <root> <delivery-started|session-ended> <id> [value]");
const root = resolve(rootArg), system = new SidmahSystem(root, new OutboxProvider(resolve(root, "state", "provider-outbox")));
if (event === "delivery-started") { system.cells.markProviderProcessingStarted(id); system.runtimes.markDirectorProcessingStarted(id); }
else if (event === "session-ended") await system.providerSessionEnded(id, value ?? "provider session ended");
else throw new Error(`Unknown provider event: ${event}`);
await system.recover(); system.close();

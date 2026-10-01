import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invariant } from "../core/errors.ts";
import { CodexQueueProvider, OutboxProvider } from "./outbox-provider.ts";

export type DeliveryMode = "collaboration" | "codex-queue";

/** Internal agents are owned by the parent harness, not by codex queue. */
export function deliveryMode(root: string): DeliveryMode {
  const path = resolve(root, "provider-config.json");
  if (!existsSync(path)) return "collaboration";
  const config = JSON.parse(readFileSync(path, "utf8"));
  invariant(config && Object.keys(config).length === 1 &&
    ["collaboration", "codex-queue"].includes(config.mode),
    "PROVIDER_CONFIG_INVALID", "provider-config.json must contain only mode: collaboration or codex-queue");
  return config.mode;
}

export function configuredProvider(root: string) {
  const outbox = resolve(root, "state", "provider-outbox");
  return deliveryMode(root) === "collaboration" ? new OutboxProvider(outbox) : new CodexQueueProvider(outbox);
}

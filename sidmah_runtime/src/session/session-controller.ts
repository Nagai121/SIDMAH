import type { ProviderDeliveryRequest, ProviderHarness } from "../core/types.ts";

/** Stateless provider boundary. Durable scheduling and dedupe live in Manager SQLite. */
export class SessionController implements ProviderHarness {
  private readonly adapter: ProviderHarness;
  constructor(adapter: ProviderHarness) { this.adapter = adapter; }
  deliver(request: ProviderDeliveryRequest) { return this.adapter.deliver(request); }
  terminate(providerSessionId: string, reason: string) { return this.adapter.terminate(providerSessionId, reason); }
}

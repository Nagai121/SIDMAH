import type { ProviderDeliveryRequest, ProviderHarness } from "../core/types.ts";

/** Stateless provider boundary. Durable scheduling and dedupe live in Manager SQLite. */
export class SessionController implements ProviderHarness {
  private readonly adapter: ProviderHarness;
  readonly redeliver?: (request: ProviderDeliveryRequest) => Promise<void>;
  constructor(adapter: ProviderHarness) {
    this.adapter = adapter;
    if (adapter.redeliver) this.redeliver = request => adapter.redeliver!(request);
  }
  deliver(request: ProviderDeliveryRequest) { return this.adapter.deliver(request); }
  terminate(providerSessionId: string, reason: string) { return this.adapter.terminate(providerSessionId, reason); }
}

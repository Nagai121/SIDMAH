import type { ProviderDeliveryRequest, ProviderHarness } from "../core/types.ts";

export class InMemoryProvider implements ProviderHarness {
  readonly spawns: never[] = [];
  readonly deliveries: ProviderDeliveryRequest[] = [];
  readonly terminations: Array<{ providerSessionId: string; reason: string }> = [];
  #delivered = new Set<string>();

  async deliver(request: ProviderDeliveryRequest) {
    if (!this.#delivered.has(request.deliveryId)) {
      this.#delivered.add(request.deliveryId);
      this.deliveries.push(request);
    }
    return { accepted: true, processingStarted: true };
  }
  async terminate(providerSessionId: string, reason: string): Promise<void> {
    if (!this.terminations.some(x => x.providerSessionId === providerSessionId)) this.terminations.push({ providerSessionId, reason });
  }
}

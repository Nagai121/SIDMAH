export type InboxKind = "cell" | "start" | "result";
export type InboxState = "pending" | "submitting" | "submitted" | "active" | "completed" | "failed" | "cancelled";

export interface CellMeaning { responsibility: string }
export interface StartMeaning {
  objective: string;
  targetAndConditions: string;
  method: string;
  observations: string;
  evaluation: string;
}
export interface EndMeaning {
  observedResults: string;
  outputAudit: string;
  hypothesisJudgement: string;
  reliabilityAndAnomalies: string;
  discussion: string;
  references: string;
}

export interface ProviderDeliveryRequest {
  deliveryId: string;
  providerSessionId: string;
  kind: "cell" | "start" | "result" | "end";
  payload: unknown;
}
export interface ProviderAcceptance { accepted: boolean; processingStarted: boolean }
export interface ProviderHarness {
  deliver(request: ProviderDeliveryRequest): Promise<ProviderAcceptance>;
  redeliver?(request: ProviderDeliveryRequest): Promise<void>;
  terminate(providerSessionId: string, reason: string): Promise<void>;
}

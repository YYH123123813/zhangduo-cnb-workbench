export type ModelPanelOperationGate = {
  sent: boolean;
  discovered: readonly unknown[];
  discovery: 'idle' | 'checking' | 'ready' | 'unknown';
};

export function canStartModelExtraction(operation: ModelPanelOperationGate, storedDelivery: { batch?: { state?: string } } | null | undefined, allowInitialExtraction = false) {
  const freshCapture = allowInitialExtraction && (operation.discovery === 'idle' || operation.discovery === 'ready');
  return freshCapture && !operation.sent && operation.discovered.length === 0 && storedDelivery?.batch?.state === 'missing';
}

export function shouldAutoDiscoverModelOperations(input: {
  recoveryApprovalId?: string;
  storedBatchState?: string;
  sent: boolean;
  discovery: ModelPanelOperationGate['discovery'];
  allowInitialExtraction?: boolean;
}) {
  return !input.recoveryApprovalId && !input.allowInitialExtraction && input.storedBatchState === 'missing' && !input.sent && input.discovery === 'idle';
}

export function shouldOfferDiscoveryRetry(operation: Pick<ModelPanelOperationGate, 'sent' | 'discovery'>) {
  return !operation.sent && operation.discovery === 'unknown';
}

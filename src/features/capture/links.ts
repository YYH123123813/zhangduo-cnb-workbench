export const handoffHref = (conversationId: string, candidateId?: string) => `#handoff?conversationId=${encodeURIComponent(conversationId)}${candidateId ? `&candidateId=${encodeURIComponent(candidateId)}&source=candidate` : ''}`;
export const manualHandoffHref = (conversationId: string) => `#handoff?conversationId=${encodeURIComponent(conversationId)}&source=manual`;
// The existing approvalId navigation key carries the registration operation ID, not Approval.id.
export const captureHref = (conversationId: string, operationId?: string) => `#capture?conversationId=${encodeURIComponent(conversationId)}${operationId ? `&approvalId=${encodeURIComponent(operationId)}` : ''}`;

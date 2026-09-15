import { ApprovalFlow, post, type ApprovalState, type RequestApi } from './approval-flow';
import { KnowledgeApprovalStateSchema } from '../../contracts/approval';
import type { prepareChanges } from './commit';
import type { verifyReceipt } from './readback';

export type PreparedChange = Awaited<ReturnType<typeof prepareChanges>>;
export type VerifiedChange = Awaited<ReturnType<typeof verifyReceipt>>;
export type ChangeState = ApprovalState<PreparedChange, VerifiedChange>;
export type { RequestApi } from './approval-flow';
export class ChangeFlow extends ApprovalFlow<PreparedChange, VerifiedChange> {
  constructor(request: RequestApi) {
    super(request, {
      binding: (p) => ({ purpose: 'commit_knowledge', workspaceId: p.changes.workspaceId, contentHash: p.changes.contentHash, baseRevision: p.changes.baseRevision, objectIds: p.objectIds }),
      available: (p) => p.approvalStatus !== 'unavailable',
      approve: (p) => ['/api/workspace/approvals/knowledge', post({ changes: p.changes, confirmed: true })],
      recoverApproval: async (api, p) => {
        const response = await api(`/api/workspace/approvals/knowledge/${encodeURIComponent(p.changes.id)}`);
        if (!response.ok) return response;
        const result = KnowledgeApprovalStateSchema.safeParse(response.data);
        return { ...response, data: result.success && result.data.changeSetId === p.changes.id ? result.data : null };
      },
      execute: (p, approval) => ['/api/governance/changes/commit', post({ action: 'commit', changes: p.changes, approval, ...(p.restoration ? { restoration: p.restoration } : {}) })],
      verify: async (api, p) => {
        const response = await api('/api/governance/changes/verify', post({ action: 'verify', changes: p.changes }));
        if (!response.ok) return response;
        const result = response.data as VerifiedChange | null;
        return { ...response, data: result?.state === 'verified' && result.snapshotVerified === true && result.receipt?.changeSetId === p.changes.id
          && result.snapshot?.workspaceId === p.changes.workspaceId && result.snapshot.revision === result.receipt.revision ? result : null };
      },
    });
  }
}

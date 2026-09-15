import type { LeaveGuard } from '../../contracts/navigation';
import type { Approval } from '../../contracts/domain';
import type { ChangeStage } from './approval-flow';
import { governancePayloadLocked, type GovernancePayloadSaveState } from './governance-operation';

export interface GovernanceNavigationState { dirty: boolean; operations: { stage: ChangeStage; approval: Approval | null }[]; payloadState?: GovernancePayloadSaveState }
export function governanceGuard(read: () => GovernanceNavigationState, onBlocked: () => void): LeaveGuard {
  return { owner: 'governance', onBlocked, getState: () => {
    const state = read();
    if (state.payloadState && governancePayloadLocked(state.payloadState)
      || state.operations.some((operation) => operation.approval || ['approving', 'approval_unknown', 'reading_approval', 'sending', 'verifying', 'unknown', 'revoking', 'revoke_unknown'].includes(operation.stage))) return 'blocked';
    return state.dirty || state.operations.some((operation) => operation.stage !== 'idle') ? 'dirty' : 'clean';
  } };
}

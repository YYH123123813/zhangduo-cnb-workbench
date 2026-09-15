export type FeaturePage = 'capture' | 'handoff' | 'retrieval' | 'learning' | 'governance' | 'conversation' | 'intelligence';
export interface AppRoute { page: FeaturePage | 'workspace' | 'invalid'; params: Readonly<Record<string, string>> }
export interface LeaveGuard {
  owner: FeaturePage | 'workspace';
  getState: () => 'clean' | 'dirty' | 'blocked';
  onBlocked?: () => void;
}
export type RegisterLeaveGuard = (guard: LeaveGuard) => () => void;

/**
 * The only route mutation allowed to preserve an in-progress handoff page.
 * It contains identifiers and a content digest, never draft or approval data.
 */
export interface HandoffOperationPin {
  conversationId: string;
  draftId: string;
  changeSetId: string;
  source: 'candidate' | 'manual';
  operationHash: string;
}

export type PinHandoffOperationResult =
  | { ok: true; route: AppRoute; hash: string; history: 'replace'; preservedPage: true }
  | { ok: false; reason: 'wrong_page' | 'conversation_mismatch' | 'operation_mismatch' | 'invalid_address'; route: AppRoute };

export type PinHandoffOperation = (address: HandoffOperationPin) => PinHandoffOperationResult;
export interface NavigationProps {
  registerLeaveGuard?: RegisterLeaveGuard;
  pinHandoffOperation?: PinHandoffOperation;
  retainOperationRecovery?: (input: RecoveryAnchorInput) => Promise<Result<RecoveryAnchor>>;
  /** Navigation intent only; null identity never authorizes a fresh business operation. */
  recoveryRequested?: boolean;
  recoveryIdentity?: RecoveryAnchorRead | null;
}
import type { Result } from './api';
import type { RecoveryAnchor, RecoveryAnchorInput, RecoveryAnchorRead } from './recovery-anchor';

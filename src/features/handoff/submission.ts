import type { Approval, CommitReceipt } from '../../contracts/domain';
import type { ApiError, Result } from '../../contracts/api';
import type { HandoffPreview } from './preview';
export interface SubmissionState {
  preview: HandoffPreview | null; approval: Approval | null; receipt: CommitReceipt | null;
  pending: boolean; unknown: boolean; approvalUnknown: boolean; rejected: boolean;
}
export function newSubmission(): SubmissionState {
  return { preview: null, approval: null, receipt: null, pending: false, unknown: false, approvalUnknown: false, rejected: false };
}
export function isSubmissionLocked(state: SubmissionState): boolean {
  return state.pending || state.unknown || state.approvalUnknown || Boolean(state.approval);
}
export function invalidateSubmission(state: SubmissionState): SubmissionState {
  return isSubmissionLocked(state) ? state : newSubmission();
}
export function isUncertainWrite(error: ApiError): boolean {
  return error.dataState === 'unknown' || error.dataState === 'partial' || error.code === 'UNKNOWN_RESULT';
}
export function settleApproval(state: SubmissionState, result: Result<Approval>): SubmissionState {
  if (result.ok) return { ...state, approval: result.data, approvalUnknown: false, rejected: false };
  return { ...state, approvalUnknown: isUncertainWrite(result.error) };
}
export function settleSubmission(state: SubmissionState, result: Result<CommitReceipt>): SubmissionState {
  if (result.ok) return { ...state, pending: false, unknown: false, approvalUnknown: false, rejected: false, approval: null, receipt: result.data };
  const unknown = isUncertainWrite(result.error);
  return { ...state, pending: false, unknown, rejected: !unknown, receipt: null };
}
export function settleReceiptRead(state: SubmissionState, result: Result<CommitReceipt>): SubmissionState {
  if (result.ok) return settleSubmission(state, result);
  // readCommit uses this exact result for a journaled branch rejection, not a failed lookup.
  if (result.error.code === 'CONFLICT' && result.error.dataState === 'preserved' && result.error.nextAction === 'preview_again') {
    return settleSubmission(state, result);
  }
  return state;
}

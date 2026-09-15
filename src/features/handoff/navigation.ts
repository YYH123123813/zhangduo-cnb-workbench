import type { ApiError } from '../../contracts/api';
import type { HandoffOperationPin, LeaveGuard } from '../../contracts/navigation';
import { hasLocalEdits } from './client-state';
import type { Review } from './model';
import { isSubmissionLocked } from './submission';
import type { SubmissionState } from './submission';

export interface HandoffOperationAddress {
  conversationId: string;
  draftId: string;
  changeSetId: string;
  source: 'candidate' | 'manual';
  operationHash: string;
}

export function matchesPinnedOperation(params: Readonly<Record<string, string | undefined>> | undefined,
  address: HandoffOperationPin | null): boolean {
  return Boolean(params && address && (['conversationId', 'draftId', 'changeSetId', 'source', 'operationHash'] as const)
    .every((key) => params[key] === address[key]));
}

/** Build an ID-only recovery address; no draft body or approval data enters the URL. */
export function handoffOperationHash(address: HandoffOperationAddress): string {
  const query = new URLSearchParams(Object.entries({
    changeSetId: address.changeSetId,
    conversationId: address.conversationId,
    draftId: address.draftId,
    operationHash: address.operationHash,
    source: address.source,
  }).sort(([left], [right]) => left.localeCompare(right))).toString();
  return `#handoff?${query}`;
}

export interface HandoffNavigationState {
  review: Review | null;
  submission: SubmissionState;
  unknownDrafts: Record<string, unknown>;
  unknownOperation?: boolean;
  busy: boolean;
}

export function handoffBlockedError(state: HandoffNavigationState): ApiError {
  const error = (message: string, nextAction: string, dataState: ApiError['dataState'] = 'preserved'): ApiError =>
    ({ code: 'CONFLICT', message, retryable: false, dataState, nextAction });
  if (state.busy || state.submission.pending) return error('请求尚未结束，请等待结果后再离开。', 'wait_request');
  if (state.unknownOperation) return error('原预览保存结果未知，请先只读核验原操作；没有重发保存、批准或提交。', 'read_original_operation', 'unknown');
  if (Object.keys(state.unknownDrafts).length) return error('草稿写入结果未知，请先核验原草稿操作；本页编辑仍保留。', 'read_back', 'unknown');
  if (state.submission.approvalUnknown) return error('批准状态未知，请核验原批准操作；未发出新的 Git 提交。', 'check_approval', 'unknown');
  if (state.submission.unknown) return error('Git 提交结果未知，请先核验原提交操作，不能通过离开取消已发出的请求。', 'read_back', 'unknown');
  if (state.submission.approval) return error('本次批准仍保留，请先撤回批准或完成对应提交。', 'revoke_approval');
  return error('审阅内容仍保留在本页。', 'continue_editing');
}

export function handoffGuard(readLatestState: () => HandoffNavigationState, onBlocked?: () => void): LeaveGuard {
  return { owner: 'handoff', getState: () => {
    const state = readLatestState();
    if (state.busy || state.unknownOperation || isSubmissionLocked(state.submission) || Object.keys(state.unknownDrafts).length) return 'blocked';
    return hasLocalEdits(state.review) ? 'dirty' : 'clean';
  }, onBlocked };
}

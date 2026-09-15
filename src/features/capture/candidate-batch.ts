import type { Result } from '../../contracts/api';
import type { Conversation } from '../../contracts/domain';
import { CandidateStateSchema, type CandidateState } from '../../contracts/candidates';
import { checkStoredCandidates } from './spans';
import { failure } from './result';

export async function checkCandidateBatch(value: unknown, conversation: Conversation): Promise<Result<CandidateState>> {
  const invalid = () => failure<CandidateState>('CONFLICT', '候选批次身份、版本或保留状态不能核验，请重新读取原现场。', 'read_candidate_state', 'preserved');
  const parsed = CandidateStateSchema.safeParse(value); if (!parsed.success) return invalid();
  const batch = parsed.data;
  if (batch.conversationId !== conversation.id || batch.conversationHash !== conversation.contentHash) return invalid();
  if (batch.state === 'missing') {
    if (batch.revision !== 0 || batch.candidates.length || batch.modelApprovalId || batch.expiresAt) return invalid();
  } else if (batch.revision < 1 || !batch.modelApprovalId || !batch.expiresAt || (batch.state === 'available' && Date.parse(batch.expiresAt) <= Date.now()) || (batch.state === 'expired' && (batch.candidates.length || Date.parse(batch.expiresAt) > Date.now()))) return invalid();
  const checked = await checkStoredCandidates(conversation, batch.candidates);
  return checked.ok ? { ok: true, data: { ...batch, candidates: checked.data } } : checked;
}

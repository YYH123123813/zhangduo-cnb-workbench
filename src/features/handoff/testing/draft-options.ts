import type { HandoffDraft } from '../../../contracts/domain';
import type { DraftSaveOptions } from '../../../contracts/handoff';
import { conversation } from './fixtures';

export function draftOptions(draft: HandoffDraft, conversationHash = conversation.contentHash): DraftSaveOptions {
  return { operationId: `save-${draft.id}`, source: { kind: 'candidate', candidateId: draft.candidateId! },
    expectedConversationHash: conversationHash, expectedRevision: 0, expectedContentHash: null, retentionDays: 30, confirmed: true };
}

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { Id, Timestamp } from '../contracts/domain';
import { canonicalJson } from '../contracts/hash';
import { ReviewQuestionSchema } from '../contracts/review-session';
import type { SessionRegistry } from './identity';
import type { OperationJournal } from './journal';
import { ReviewQuestionStore } from './review-sessions';

const Import = z.object({ operationId: Id, workspaceId: Id, questions: z.array(ReviewQuestionSchema).min(1).max(100),
  retentionDays: z.literal(30), confirmed: z.literal(true) }).strict();
const Receipt = z.object({ operationId: Id, workspaceId: Id, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  questionCount: z.number().int().positive(), importedAt: Timestamp, expiresAt: Timestamp, retentionDays: z.literal(30) }).strict();

export function readPrivateReviewCatalog(file: string, mode: 'live' | 'fixture'): unknown {
  if (!new RegExp(`^\\.local/${mode}/[A-Za-z0-9_-]+\\.review\\.json$`).test(file)) throw new Error('Invalid private catalog location');
  for (const dir of ['.local', `.local/${mode}`]) if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Invalid private catalog directory');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_000_000) throw new Error('Catalog must be a private regular file, at most 1MB');
    return Import.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}

export function importReviewCatalog(sessions: SessionRegistry, journal: OperationJournal, input: unknown, expectedWorkspaceId: string) {
  const request = Import.parse(input);
  if (request.workspaceId !== expectedWorkspaceId || request.questions.some((q) => q.workspaceId !== expectedWorkspaceId || q.nodeRef.workspaceId !== expectedWorkspaceId
    || q.review.status !== 'approved' || !q.review.reviewedBy || !q.review.reviewedAt || new Set(q.rubric.criteria.map((c) => c.id)).size !== q.rubric.criteria.length
    || (q.kind === 'near_transfer' && (!q.transfer || q.transfer.dimension === 'numbers_only' || !q.rubric.necessaryConditions.length)))) throw new Error('Catalog requires reviewed questions bound to the verified workspace');
  if (new Set(request.questions.map((q) => canonicalJson([q.id, q.revision]))).size !== request.questions.length) throw new Error('Duplicate question revisions');
  const requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex');
  const store = new ReviewQuestionStore(sessions, journal);
  return journal.transaction(() => {
    const prior = journal.record(expectedWorkspaceId, '@workspace', 'review_catalog_receipt', request.operationId);
    if (prior) {
      const receipt = Receipt.parse(prior.value);
      if (receipt.requestHash !== requestHash) throw new Error('Import operation already belongs to another catalog');
      return receipt;
    }
    const now = Date.now();
    const receipt = Receipt.parse({ operationId: request.operationId, workspaceId: expectedWorkspaceId, requestHash, questionCount: request.questions.length,
      importedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString(), retentionDays: 30 });
    for (const q of request.questions) if (!store.registerWithinTransaction(q, receipt.expiresAt) || !store.bound(q, now)) throw new Error('Immutable question revision conflict, expired version or capacity exceeded');
    if (!journal.putRecord(expectedWorkspaceId, '@workspace', 'review_catalog_receipt', request.operationId, receipt, null)) throw new Error('Import receipt conflict');
    return receipt;
  });
}

import { vi } from 'vitest';
import type { Approval, ChangeSet, CommitReceipt, HandoffDraft, KnowledgeSnapshot } from '../../../contracts/domain';
import type { Services } from '../../../contracts/ports';
import { canonicalJson } from '../../../contracts/hash';
import { failure } from '../model';
import { appFor } from './app';
import { context, fixtureServices } from './services';
import { snapshot } from './knowledge';

export function workflowFixture() {
  const versions = new Map<string, KnowledgeSnapshot>([[snapshot.revision, structuredClone(snapshot)]]);
  const drafts = new Map<string, HandoffDraft>();
  const approvals = new Map<string, Approval>();
  const revoked = new Set<string>();
  const receipts = new Map<string, { hash: string; receipt: CommitReceipt }>();
  let head = snapshot.revision; let writes = 0; let unknownNext = false;
  const services = fixtureServices({
    approveKnowledge: vi.fn<NonNullable<Services['approveKnowledge']>>(async (_ctx, input) => input.changes.baseRevision === head ?
      { ok: true, data: approve(input.changes) } : failure('HEAD changed', 'CONFLICT', 'refresh_preview', 'preserved')),
    readCommit: vi.fn<NonNullable<Services['readCommit']>>(async (_ctx, id) => ({ ok: true, data: receipts.get(id)?.receipt ?? null })),
    revokeApproval: vi.fn<NonNullable<Services['revokeApproval']>>(async (ctx, id) => {
      if (approvals.get(id)?.actorId !== ctx.actorId || approvals.get(id)?.workspaceId !== ctx.workspaceId) return failure('Approval unavailable', 'FORBIDDEN');
      revoked.add(id); return { ok: true, data: { revoked: true } };
    }),
    snapshot: vi.fn(async (_ctx, revision) => versions.has(revision ?? head) ? { ok: true as const, data: structuredClone(versions.get(revision ?? head)!) } : failure<KnowledgeSnapshot>('Version unavailable', 'UPSTREAM')),
    saveDraft: vi.fn(async (_ctx, draft) => { drafts.set(draft.id, structuredClone(draft)); return { ok: true as const, data: draft }; }),
    readDraft: vi.fn(async (_ctx, id) => drafts.has(id) ? { ok: true as const, data: structuredClone(drafts.get(id)!) } : failure<HandoffDraft>('No saved draft', 'VALIDATION', 'create_draft')),
    commit: vi.fn<Services['commit']>(async (_ctx, changes, approval) => {
      const registered = approvals.get(approval.id);
      if (!registered || revoked.has(approval.id) || canonicalJson(registered) !== canonicalJson(approval)) return failure<CommitReceipt>('Approval not registered or revoked', 'FORBIDDEN', 'approve_again');
      const previous = receipts.get(changes.id);
      if (previous) return previous.hash === changes.contentHash ? { ok: true as const, data: previous.receipt } : failure<CommitReceipt>('Operation content changed', 'CONFLICT');
      if (changes.baseRevision !== head) return failure<CommitReceipt>('HEAD changed', 'CONFLICT', 'refresh_preview', 'preserved');
      writes++;
      const old = versions.get(head)!;
      head = `fixture-commit-${writes}`;
      const changedIds = new Set(changes.nodes.map((node) => node.id));
      versions.set(head, { ...old, revision: head, nodes: [...old.nodes, ...changes.nodes.map((node) => ({ ...node, revision: head }))],
        relations: [...old.relations, ...changes.relations.map((relation) => ({ ...relation,
          source: changedIds.has(relation.source.objectId) ? { ...relation.source, revision: head } : relation.source,
          target: changedIds.has(relation.target.objectId) ? { ...relation.target, revision: head } : relation.target }))] });
      const receipt: CommitReceipt = { changeSetId: changes.id, revision: head, commitUrl: `https://cnb.cool/fixture/private/-/commit/${head}`, indexing: 'pending' };
      receipts.set(changes.id, { hash: changes.contentHash, receipt });
      if (unknownNext) { unknownNext = false; return failure<CommitReceipt>('Response interrupted', 'UNKNOWN_RESULT', 'read_back', 'unknown'); }
      return { ok: true as const, data: receipt };
    }),
  });
  function approve(changes: ChangeSet): Approval {
    const approval: Approval = { id: crypto.randomUUID(), actorId: context.actorId, workspaceId: context.workspaceId,
      purpose: 'commit_knowledge', objectIds: [...new Set([...changes.nodes.map((node) => node.id), ...changes.relations.map((relation) => relation.id), ...changes.withdrawnIds])],
      contentHash: changes.contentHash, baseRevision: changes.baseRevision,
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() };
    approvals.set(approval.id, approval); return structuredClone(approval);
  }
  return { app: appFor(services), services, approve, revoked, drafts,
    writes: () => writes, current: () => structuredClone(versions.get(head)!), interruptNext: () => { unknownNext = true; },
    advanceHead: () => { const old = versions.get(head)!; head = 'fixture-other-writer'; versions.set(head, { ...old, revision: head }); } };
}

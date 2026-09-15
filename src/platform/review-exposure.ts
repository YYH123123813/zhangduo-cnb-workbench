import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext } from '../contracts/api';
import { Timestamp, VersionRefSchema, type VersionRef } from '../contracts/domain';
import { canonicalJson } from '../contracts/hash';
import type { OperationJournal } from './journal';

const Entry = z.object({ nodeRef: VersionRefSchema, expiresAt: Timestamp, seenAt: Timestamp.nullable() }).strict();

// Records exist only after explicit attempt retention consent. No query, task or answer text is stored here.
export class ReviewExposureLedger {
  constructor(private readonly journal: OperationJournal, private readonly now: () => number = Date.now) {}
  private key(ref: VersionRef) { return createHash('sha256').update(canonicalJson(ref)).digest('hex'); }
  active(ctx: RequestContext, ref: VersionRef) {
    const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'review_exposure', this.key(ref));
    if (!row) return null;
    const entry = Entry.parse(row.value);
    if (entry.nodeRef.workspaceId !== ctx.workspaceId || canonicalJson(entry.nodeRef) !== canonicalJson(ref)) throw new Error('Exposure identity mismatch');
    return Date.parse(entry.expiresAt) > this.now() ? entry : null;
  }
  consent(ctx: RequestContext, ref: VersionRef, expiresAt: string) {
    const entry = this.active(ctx, ref), key = this.key(ref);
    const row = this.journal.record(ctx.workspaceId, ctx.actorId, 'review_exposure', key);
    const value = Entry.parse({ nodeRef: ref, expiresAt: entry && entry.expiresAt > expiresAt ? entry.expiresAt : expiresAt, seenAt: entry?.seenAt ?? null });
    if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'review_exposure', key, value, row?.version ?? null)) throw new Error('Exposure consent conflict');
  }
  seen(ctx: RequestContext, ref: VersionRef) {
    const entry = this.active(ctx, ref); if (!entry) return;
    if (entry.seenAt) return;
    const key = this.key(ref), row = this.journal.record(ctx.workspaceId, ctx.actorId, 'review_exposure', key)!;
    if (!this.journal.putRecord(ctx.workspaceId, ctx.actorId, 'review_exposure', key, { ...entry, seenAt: new Date(this.now()).toISOString() }, row.version)) throw new Error('Exposure receipt conflict');
  }
}

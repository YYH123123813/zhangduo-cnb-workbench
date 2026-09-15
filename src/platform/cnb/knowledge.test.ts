import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../../../tests/integration/platform-fixture';
import type { OperationJournal } from '../journal';
import { indexFiles, indexPath } from './knowledge';

const journals: OperationJournal[] = [];
afterEach(() => journals.splice(0).forEach((journal) => journal.close()));
describe('W08 semantic locations and approved indexing inputs', () => {
  it('keeps only approved paths/IDs, reads current text and does not trust chunk content or coverage', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    const original = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => String(args[0]).includes('/knowledge/base/query') ? Response.json([
      { score: 0.8, chunk: 'OUTDATED PRIVATE VECTOR', metadata: { path: indexPath('k1') } },
      { score: 1, chunk: 'PRIVATE ISSUE', metadata: { path: 'issues/private.md' } },
      { score: 1, chunk: 'DELETED DATA', metadata: { path: indexPath('absent') } },
    ]) : original(...args));
    const result = await s.services.semanticQueryWithStatus!(s.ctx, 'A query ... with punctuation');
    expect(result).toMatchObject({ ok: true, data: { indexRevision: null, coverage: 'partial', hits: [{ objectId: 'k1', score: 0.8, text: 'Original fixture conclusion' }] } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    s.journal.block(s.ctx.workspaceId, ['k1'], 'fixture-delete');
    expect(await s.services.semanticQuery(s.ctx, 'fixture')).toEqual({ ok: true, data: [] });
  });
  it('omits unconfirmed, withdrawn, excluded and private source objects from index input files', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    const document = { ...s.initial, nodes: [s.node, { ...s.node, id: 'draft', confirmation: 'draft' as const }, { ...s.node, id: 'withdrawn', lifecycle: 'withdrawn' as const }, { ...s.node, id: 'blocked' }], excludedIds: ['blocked'] };
    expect(Object.keys(indexFiles(document))).toEqual([indexPath('k1')]);
    expect(Object.values(indexFiles(document)).join('\n')).not.toContain('issues/');
  });
  it('rejects a forged context and malformed upstream scores instead of returning invented results', async () => {
    const s = await platformFixture(); journals.push(s.journal);
    expect((await s.services.semanticQuery({ ...s.ctx }, 'fixture')).ok).toBe(false);
    const original = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => String(args[0]).includes('/knowledge/base/query') ? Response.json([{ score: 9, chunk: 'bad', metadata: { path: indexPath('k1') } }]) : original(...args));
    expect(await s.services.semanticQuery(s.ctx, 'fixture')).toMatchObject({ ok: false, error: { code: 'UPSTREAM' } });
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readableDiff } from './preview';
import { PreviewPanel } from './PreviewPanel';
import { invalidateSubmission, newSubmission } from './submission';
import { buildChangeSet } from './changes';
import { draftFixture } from './testing/review';
import { context } from './testing/services';
import { snapshot } from './testing/knowledge';
import { candidate, time } from './testing/fixtures';

async function previewFixture() {
  const { draft, review } = draftFixture();
  const result = await buildChangeSet(draft, review, snapshot, context, 'op-preview', '知识交接', time);
  if (!result.ok) throw Error('fixture');
  return { draft, changes: result.data, diff: readableDiff(result.data, snapshot, candidate()) };
}
describe('H09 readable review without side effects', () => {
  it('shows the exact expression, unknown conditions, sources and retrieval consequence', async () => {
    const preview = await previewFixture();
    const html = renderToStaticMarkup(createElement(PreviewPanel, { preview, onEdit: () => {} }));
    expect(html).toContain('我的限定陈述');
    expect(html).toContain('适用前提尚未核验');
    expect(html).toContain('来源');
    expect(html).toContain('未写入 Git');
    expect(html).toContain('返回修改');
  });
  it('never hides withdrawals or source omissions in the diff', async () => {
    const preview = await previewFixture();
    preview.changes.nodes[0]!.sources = [];
    preview.changes.withdrawnIds = ['node-2', 'unknown-id'];
    const diff = readableDiff(preview.changes, snapshot, candidate());
    expect(diff.rows.filter((row) => row.action === 'remove')).toHaveLength(3);
    expect(diff.rows.some((row) => row.label.includes('unknown-id'))).toBe(true);
  });
  it('invalidates the preview only after the registered approval has been explicitly revoked', async () => {
    const preview = await previewFixture();
    const registered = { ...newSubmission(), preview, approval: { id: 'old', actorId: context.actorId, workspaceId: context.workspaceId,
      purpose: 'commit_knowledge' as const, objectIds: [preview.changes.nodes[0]!.id], contentHash: preview.changes.contentHash,
      baseRevision: snapshot.revision, approvedAt: time, expiresAt: '2026-09-05T05:00:00.000Z' } };
    expect(invalidateSubmission(registered)).toBe(registered);
    const next = invalidateSubmission({ ...registered, approval: null });
    expect(next.preview).toBeNull(); expect(next.approval).toBeNull();
  });
  it('does not label an in-flight or unknown Git write as not written', async () => {
    const preview = await previewFixture();
    for (const gitState of ['pending', 'unknown'] as const) {
      const html = renderToStaticMarkup(createElement(PreviewPanel, { preview, gitState, locked: true, onEdit: () => {} }));
      expect(html).not.toContain('未写入 Git');
      expect(html).toContain(gitState === 'pending' ? 'Git 提交待回执' : 'Git 写入结果未知');
      expect(html).toContain('disabled=""');
    }
  });
});

import { vi } from 'vitest';
import type { ApiResponse } from '../../../contracts/api';
import type { Candidate } from '../../../contracts/domain';
import { hashSegment, hashSettings } from '../../../contracts/hash';
import { platformFixture } from '../../../../tests/integration/platform-fixture';
import { createServices } from '../../../platform/services';
import { ApprovalAuthority } from '../../../platform/approvals';
import type { ModelTransport } from '../../../platform/model';
import { appFor } from './app';
import { candidate, conversation } from './fixtures';
import { assessSource, setKeyCondition, writeStatement } from '../model';
import type { Review } from '../model';
import { toDraft } from '../draft';
import type { HandoffPreview } from '../preview';

export async function handoffPlatformFixture(file?: string, sourceMode: 'candidate' | 'manual' = 'candidate') {
  const platform = await platformFixture(file);
  const issue = { number: '7', title: 'Synthetic handoff source', body: conversation.segments[0]!.text,
    created_at: '2026-09-05T00:00:00Z', invisible: true };
  const transport = platform.transport.getMockImplementation()!;
  platform.transport.mockImplementation(async (...args) => String(args[0]).endsWith('/issues/7') ? Response.json(issue) : transport(...args));
  const loaded = await platform.services.readIssue(platform.ctx, 7);
  if (!loaded.ok) throw Error(JSON.stringify(loaded));
  const source = loaded.data, segment = source.segments[1]!, original = candidate();
  const span = { segmentId: segment.id, start: 0, end: segment.text.length, quote: segment.text };
  const proposal = { title: original.title, question: original.question, claim: original.claim, kind: original.kind,
    whyKeep: original.whyKeep, uncertainties: original.uncertainties, spans: [span] };
  const generatedAt = new Date().toISOString();
  // Only external transports are synthetic. All storage, source reads and authority use shared Services.
  const model: ModelTransport = { mode: 'fixture', complete: vi.fn(async () => ({ ok: true as const,
    data: { value: { candidates: [proposal] }, modelId: 'fixture-no-external-model', generatedAt } })) };
  const authority = new ApprovalAuthority(platform.sessions, platform.journal, () => Date.now());
  const options = { ...platform.options, approvalAuthority: authority, model }, services = createServices(options);
  const existing = sourceMode === 'candidate' ? await services.readCandidateState!(platform.ctx, source.id) : null;
  if (existing && !existing.ok) throw Error(JSON.stringify(existing));
  if (existing?.ok && existing.data.state === 'missing') {
    const settingsState = await services.settingsState!(platform.ctx);
    if (!settingsState.ok) throw Error(JSON.stringify(settingsState));
    const settings = { ...settingsState.data.settings, aiExtraction: true };
    const settingsApproval = await services.approveGovernance!(platform.ctx, { purpose: 'settings', settings, baseRevision: platform.base,
      expectedSettingsHash: await hashSettings(platform.ctx.workspaceId, platform.base, settingsState.data.settings), expectedSettingsRevision: settingsState.data.revision, confirmed: true });
    if (!settingsApproval.ok) throw Error(JSON.stringify(settingsApproval));
    const configured = await services.saveSettings(platform.ctx, settings, settingsApproval.data);
    if (!configured.ok) throw Error(JSON.stringify(configured));
    const input = { purpose: 'extract' as const, text: segment.text, sourceIds: [segment.id] };
    const approved = await services.approveModel!(platform.ctx, { input, objectIds: input.sourceIds,
      conversationId: source.id, baseRevision: source.contentHash, confirmed: true });
    if (!approved.ok) throw Error(JSON.stringify(approved));
    const output = await services.complete(platform.ctx, { ...input, approval: approved.data });
    if (!output.ok) throw Error(JSON.stringify(output));
    const generated: Candidate = { ...original, conversationId: source.id, modelId: output.data.modelId, generatedAt: output.data.generatedAt,
      spans: [{ ...span, id: 'source-1', conversationId: source.id, contentHash: await hashSegment(source.id, segment) }],
      sources: [{ ...original.sources[0]!, excerpt: segment.text, supportedClaim: original.claim, url: source.issueUrl, accessedAt: output.data.generatedAt }] };
    const saved = await services.saveCandidates(platform.ctx, source.id, [generated], { modelApproval: approved.data,
      expectedConversationHash: source.contentHash, expectedRevision: 0, retentionDays: 7, confirmed: true });
    if (!saved.ok) throw Error(JSON.stringify(saved));
  }
  const app = appFor(services);
  async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers = platform.headers) {
    const response = await app.request(`/api/handoff/${source.id}${path}`, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, result: await response.json() as ApiResponse<T> };
  }
  return { ...platform, authority, options, services, source, issue, model, app, request };
}

export async function platformPreview(fixture: Awaited<ReturnType<typeof handoffPlatformFixture>>) {
  const loaded = await fixture.request<Review>('');
  if (!loaded.result.ok) throw new Error(JSON.stringify(loaded.result));
  const review = loaded.result.data;
  let item = writeStatement({ ...review.items[0]!, disposition: 'handoff' }, '当目标前提成立时，才采用本条限定结论。');
  const conditioned = setKeyCondition(item, '先核验目标前提', 'confirmed');
  if (!conditioned.ok) throw new Error(JSON.stringify(conditioned));
  const assessed = assessSource(conditioned.data, 'source-1', 'partial', '原句只支持先核验，不证明所有结论');
  if (!assessed.ok) throw new Error(JSON.stringify(assessed));
  item = assessed.data;
  item.boundaries = ['不适用于前提已变化的任务'];
  const now = new Date().toISOString();
  item.relations = [{ id: 'handoff-platform-relation', workspaceId: review.conversation.workspaceId,
    source: { workspaceId: review.conversation.workspaceId, objectId: item.nodeId, revision: fixture.base },
    target: { workspaceId: fixture.ctx.workspaceId, objectId: fixture.node.id, revision: fixture.base },
    type: 'depends_on', rationale: '本条依赖目标前提', evidenceIds: ['source-1'], state: 'confirmed',
    proposedBy: review.actorId, confirmedBy: review.actorId, confirmedAt: now, updatedAt: now }];
  const draft = toDraft(review, item, fixture.base, now);
  if (!draft.ok) throw new Error(JSON.stringify(draft));
  const previewed = await fixture.request<HandoffPreview>('/preview', { draft: draft.data, reason: '保留有条件的判断' });
  if (!previewed.result.ok) throw new Error(JSON.stringify(previewed.result));
  return { review, item, draft: previewed.result.data.draft, preview: previewed.result.data,
    input: { draft: previewed.result.data.draft, changes: previewed.result.data.changes, confirmed: true as const } };
}

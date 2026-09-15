import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationJournal } from '../journal';
import { ApprovalAuthority } from '../approvals';
import { SessionRegistry } from '../identity';
import { CnbClient, readServerConfig } from './client';
import { createServices } from '../services';
import { hashConversation } from '../../contracts/hash';
import type { Conversation } from '../../contracts/domain';
import { createApp } from '../../server/app';

const journals: OperationJournal[] = [];
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });

async function setup() {
  let now = Date.now();
  const journal = new OperationJournal(':memory:', { fixture: true });
  journals.push(journal);
  const sessions = new SessionRegistry(() => now);
  const workspace = { id: 'w1', slug: 'fixture/project', mode: 'fixture' as const, visibility: 'private' as const };
  const token = sessions.issue({ actorId: 'u1', workspace, scopes: ['workspace:read', 'conversation:read', 'conversation:write'] });
  const result = sessions.context(new Request('http://localhost/', { headers: { Cookie: `zhangduo_session=${token}` } }));
  if (!result.ok) throw new Error('Invalid test context');
  const ctx = result.data;
  const approvalAuthority = new ApprovalAuthority(sessions, journal, () => now);
  const remote: { number: string; body: string; title: string; invisible: boolean; created_at: string }[] = [];
  let timeout = false;
  const transport = vi.fn<typeof fetch>(async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body));
      const issue = { ...body, number: String(remote.length + 1), created_at: new Date(now).toISOString() };
      remote.push(issue);
      if (timeout) throw new Error('Network result unknown');
      return Response.json(issue, { status: 201 });
    }
    if (String(url).includes('?')) return Response.json(remote);
    return Response.json(remote.find((issue) => String(url).endsWith(`/${issue.number}`)) ?? {}, { status: remote.length ? 200 : 404 });
  });
  const cnb = new CnbClient(() => readServerConfig({ CNB_REPO_SLUG: workspace.slug, CNB_TOKEN: 'fixture-secret', CNB_TOKEN_SCOPES: 'repo-issue:rw', CNB_LIVE_READS_FOR: workspace.slug, CNB_LIVE_WRITES_FOR: workspace.slug }), transport);
  const services = createServices({ sessions, cnb, journal, approvalAuthority });
  const conversation: Conversation = { id: 'c1', workspaceId: 'w1', taskId: 't1', origin: 'paste', sourceAlreadyPersisted: false, segments: [{ id: 's1', role: 'user', text: 'Explicitly selected text' }], contentHash: 'pending', createdAt: new Date(now).toISOString(), state: 'preview' };
  conversation.contentHash = await hashConversation(conversation);
  const approve = (value = conversation) => approvalAuthority.approveConversation(ctx, { conversation: value, baseRevision: 'new', confirmed: true });
  const approved = await approve();
  if (!approved.ok) throw new Error('Expected approval');
  return { services, ctx, conversation, approval: approved.data, approve, approvalAuthority, remote, transport, journal, sessions, token,
    timeout: () => { timeout = true; }, expireApproval: () => { now += 15 * 60_000; } };
}

describe('W05 private Issue persistence and durable operation identity', () => {
  it('saves an explicitly selected existing-Issue subset as a new private capture without altering the source', async () => {
    const s = await setup();
    const original = { number: '77', body: 'UNSELECTED_SYNTHETIC_ORIGINAL', title: 'Original fixture', invisible: true, created_at: s.conversation.createdAt };
    s.remote.push(original);
    const selected = { ...s.conversation, id: 'selected-new-capture', origin: 'cnb_issue' as const, sourceAlreadyPersisted: true };
    selected.contentHash = await hashConversation(selected);
    const approved = await s.approve(selected); expect(approved.ok).toBe(true); if (!approved.ok) return;
    const saved = await s.services.saveConversation(s.ctx, selected, approved.data);
    expect(saved).toMatchObject({ ok: true, data: { id: selected.id, sourceAlreadyPersisted: true, issueNumber: 2, state: 'saved' } });
    expect(s.remote[0]).toEqual(original); expect(s.remote[1]!.body).not.toContain(original.body);
    expect(s.transport.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('does not reinterpret an original Issue identity, a saved target or a supplied destination as a new capture', async () => {
    const s = await setup();
    for (const patch of [{ id: 'cnb-issue:original:77' }, { state: 'saved' as const }, { issueNumber: 77 }, { issueUrl: 'https://cnb.cool/fixture/project/-/issues/77' }]) {
      const input = { ...s.conversation, ...patch }; input.contentHash = await hashConversation(input);
      expect((await s.approve(input)).ok).toBe(false);
      const registered = s.approvalAuthority.register(s.ctx, 'conversation:write', { purpose: 'save_conversation', objectIds: [input.id], contentHash: input.contentHash, baseRevision: 'new' });
      if (!registered.ok) throw new Error('Expected fixture approval');
      expect((await s.services.saveConversation(s.ctx, input, registered.data)).ok).toBe(false);
    }
    expect(s.transport).not.toHaveBeenCalled();
  });
  it('creates once, reads back and preserves original roles/IDs across repeat and readConversation', async () => {
    const s = await setup();
    const first = await s.services.saveConversation(s.ctx, s.conversation, s.approval);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toMatchObject({ id: 'c1', state: 'saved', issueNumber: 1, sourceAlreadyPersisted: true, segments: s.conversation.segments });
    expect(await s.services.saveConversation(s.ctx, s.conversation, s.approval)).toEqual(first);
    expect(await s.services.readConversation(s.ctx, 'c1')).toEqual(first);
    expect(s.remote).toHaveLength(1);
    expect(s.remote[0]?.invisible).toBe(true);
    expect(s.transport.mock.calls.filter(([, options]) => options?.method === 'GET').length).toBeGreaterThan(0);
  });
  it('recovers an unknown write by reading back without issuing a second POST', async () => {
    const s = await setup();
    s.timeout();
    expect(await s.services.saveConversation(s.ctx, s.conversation, s.approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT', dataState: 'unknown' } });
    expect((await s.services.saveConversation(s.ctx, s.conversation, s.approval)).ok).toBe(true);
    expect(s.remote).toHaveLength(1);
    expect(s.transport.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('recovers from list summaries by verifying each matching Issue detail', async () => {
    const s = await setup();
    const original = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => String(args[0]).includes('?')
      ? Response.json(s.remote.map(({ number, title }) => ({ number, title }))) : original(...args));
    s.timeout();
    await s.services.saveConversation(s.ctx, s.conversation, s.approval);
    expect(await s.services.readConversation(s.ctx, 'c1')).toMatchObject({ ok: true, data: { state: 'saved' } });
    expect(s.remote).toHaveLength(1);
  });
  it('releases a claimed but unsent write if approval expires before transport', async () => {
    const s = await setup();
    const claim = s.journal.claim.bind(s.journal);
    s.journal.claim = (operation) => { const result = claim(operation); s.expireApproval(); return result; };
    expect(await s.services.saveConversation(s.ctx, s.conversation, s.approval)).toMatchObject({ ok: false, error: { dataState: 'not_written' } });
    s.journal.claim = claim;
    const renewed = await s.approve();
    if (!renewed.ok) throw new Error('Expected renewed approval');
    expect((await s.services.saveConversation(s.ctx, s.conversation, renewed.data)).ok).toBe(true);
    expect(s.remote).toHaveLength(1);
  });
  it('rejects an oversized envelope without claiming an unknown operation', async () => {
    const s = await setup();
    s.conversation.segments[0]!.text = 'x'.repeat(1_000_001);
    s.conversation.contentHash = await hashConversation(s.conversation);
    const approval = await s.approve();
    if (!approval.ok) throw new Error('Expected approval');
    expect(await s.services.saveConversation(s.ctx, s.conversation, approval.data)).toMatchObject({ ok: false, error: { code: 'VALIDATION', dataState: 'not_written' } });
    expect(s.journal.conversation('w1', 'c1')).toBeUndefined();
    expect(s.transport).not.toHaveBeenCalled();
  });
  it('does not treat an empty search result as proof that a timed-out write did not happen', async () => {
    const s = await setup();
    s.timeout();
    await s.services.saveConversation(s.ctx, s.conversation, s.approval);
    s.remote.length = 0;
    expect(await s.services.saveConversation(s.ctx, s.conversation, s.approval)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RESULT' } });
    expect(s.transport.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('rejects forged, withdrawn, expired and content-mismatched approvals with zero writes', async () => {
    for (const action of ['forged', 'revoked', 'expired', 'changed']) {
      const s = await setup();
      let approval = s.approval;
      let conversation = s.conversation;
      if (action === 'forged') approval = { ...approval, id: 'not-registered' };
      if (action === 'revoked') s.approvalAuthority.revoke(s.ctx, approval.id);
      if (action === 'expired') s.expireApproval();
      if (action === 'changed') conversation = { ...conversation, segments: [{ ...conversation.segments[0]!, text: 'not approved' }] };
      expect((await s.services.saveConversation(s.ctx, conversation, approval)).ok).toBe(false);
      expect(s.remote).toHaveLength(0);
    }
  });
  it('rejects a reused conversation ID with newly approved different content', async () => {
    const s = await setup();
    await s.services.saveConversation(s.ctx, s.conversation, s.approval);
    const changed = { ...s.conversation, segments: [{ ...s.conversation.segments[0]!, text: 'new text' }] };
    changed.contentHash = await hashConversation(changed);
    const approval = await s.approve(changed);
    if (!approval.ok) throw new Error('Expected new approval');
    expect(await s.services.saveConversation(s.ctx, changed, approval.data)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(s.remote).toHaveLength(1);
  });
  it('keeps concurrent submission to at most one remote create', async () => {
    const s = await setup();
    await Promise.all([s.services.saveConversation(s.ctx, s.conversation, s.approval), s.services.saveConversation(s.ctx, s.conversation, s.approval)]);
    expect(s.remote).toHaveLength(1);
  });
  it('does not mint approval when confirmation or workspace binding is invalid', async () => {
    const s = await setup();
    expect((await s.approvalAuthority.approveConversation(s.ctx, { conversation: s.conversation, baseRevision: 'new', confirmed: false })).ok).toBe(false);
    expect((await s.approvalAuthority.approveConversation(s.ctx, { conversation: { ...s.conversation, workspaceId: 'w2' }, baseRevision: 'new', confirmed: true })).ok).toBe(false);
  });
  it('exposes authenticated approve/revoke routes and does not trust approval data from the browser', async () => {
    const s = await setup();
    const app = createApp(s.services);
    const headers = { Cookie: `zhangduo_session=${s.token}`, Origin: 'http://localhost', 'Content-Type': 'application/json' };
    const response = await app.request('/api/workspace/approvals/conversations', { method: 'POST', headers, body: JSON.stringify({ conversation: s.conversation, baseRevision: 'new', confirmed: true }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.actorId).toBe(s.ctx.actorId);
    expect(body.meta.mode).toBe('fixture');
    expect((await app.request(`/api/workspace/approvals/${body.data.id}/revoke`, { method: 'POST', headers })).status).toBe(200);
    expect((await s.services.saveConversation(s.ctx, s.conversation, body.data)).ok).toBe(false);
    expect(s.remote).toHaveLength(0);
  });
  it('does not report not_written when a session is revoked after the remote create', async () => {
    const s = await setup();
    const original = s.transport.getMockImplementation()!;
    s.transport.mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[1]?.method === 'POST') s.sessions.revoke(s.token);
      return response;
    });
    const result = await s.services.saveConversation(s.ctx, s.conversation, s.approval);
    expect(s.remote).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.dataState).toBe('unknown');
  });
});

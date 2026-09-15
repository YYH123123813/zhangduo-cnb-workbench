import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SessionRegistry } from '../src/platform/identity';
import { ApprovalAuthority } from '../src/platform/approvals';
import { OperationJournal } from '../src/platform/journal';
import { CnbClient, readServerConfig } from '../src/platform/cnb/client';
import { createServices } from '../src/platform/services';
import { hashConversation } from '../src/contracts/hash';
import type { Approval, Conversation } from '../src/contracts/domain';

// An opt-in review harness: fake CNB transport only; optional HTTP reads target
// a temporary fixture database on the existing loopback development server.
async function fixture() {
  let now = Date.parse('2026-09-05T06:00:00Z');
  const journal = new OperationJournal(':memory:', { fixture: true });
  const sessions = new SessionRegistry(() => now);
  const workspace = { id: 'review-w1', slug: 'fixture/review', mode: 'fixture' as const, visibility: 'private' as const };
  const token = sessions.issue({ actorId: 'review-u1', workspace, scopes: ['workspace:read', 'conversation:read', 'conversation:write'] });
  const context = sessions.context(new Request('http://localhost/', { headers: { Cookie: `zhangduo_session=${token}` } }));
  assert(context.ok);
  const ctx = context.data;
  const approvals = new ApprovalAuthority(sessions, journal, () => now);
  const remote: { number: string; title: string; body: string; invisible: boolean; created_at: string }[] = [];
  const calls: { method: string; path: string }[] = [];
  let loseCreateResponse = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    if (method === 'POST') {
      const payload = JSON.parse(String(init?.body));
      const issue = { ...payload, number: String(remote.length + 1), created_at: new Date(now).toISOString() };
      remote.push(issue);
      if (loseCreateResponse) throw new Error('Fixture: POST succeeded but response was lost');
      return Response.json(issue, { status: 201 });
    }
    if (url.pathname.endsWith('/-/issues')) {
      // CNB OpenAPI ListIssues returns api.Issue, not api.IssueDetail.
      return Response.json(remote.map(({ body: _body, ...summary }) => summary));
    }
    const issue = remote.find((item) => url.pathname.endsWith(`/-/issues/${item.number}`));
    return issue ? Response.json(issue) : Response.json({}, { status: 404 });
  };
  const cnb = new CnbClient(() => readServerConfig({
    CNB_REPO_SLUG: workspace.slug, CNB_TOKEN: 'fixture-review-token',
    CNB_TOKEN_SCOPES: 'repo-issue:rw', CNB_LIVE_READS_FOR: workspace.slug, CNB_LIVE_WRITES_FOR: workspace.slug,
  }), transport);
  const services = createServices({ sessions, cnb, journal, approvalAuthority: approvals });
  const conversation: Conversation = {
    id: 'review-c1', workspaceId: workspace.id, taskId: 'review-t1', origin: 'paste',
    sourceAlreadyPersisted: false, segments: [{ id: 'review-s1', role: 'user', text: 'Synthetic review text only' }],
    contentHash: 'pending', createdAt: new Date(now).toISOString(), state: 'preview',
  };
  conversation.contentHash = await hashConversation(conversation);
  const approve = async () => {
    const result = await approvals.approveConversation(ctx, { conversation, baseRevision: 'new', confirmed: true });
    assert(result.ok);
    return result.data;
  };
  return { journal, services, ctx, conversation, approve, remote, calls,
    loseResponse: () => { loseCreateResponse = true; },
    expireApproval: () => { now += 15 * 60_000; },
  };
}

const results: { name: string; passed: boolean; detail?: string }[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : 'Check failed' }); }
}

await check('CONTROL: normal save is read back with one remote POST', async () => {
  const s = await fixture();
  try {
    const saved = await s.services.saveConversation(s.ctx, s.conversation, await s.approve());
    assert(saved.ok, JSON.stringify(saved));
    assert.equal(s.remote.length, 1);
    assert.equal(saved.data.state, 'saved');
  } finally { s.journal.close(); }
});

await check('R1: recover lost POST response from documented Issue summaries', async () => {
  const s = await fixture();
  try {
    s.loseResponse();
    const approval = await s.approve();
    const first = await s.services.saveConversation(s.ctx, s.conversation, approval);
    assert(!first.ok && first.error.code === 'UNKNOWN_RESULT');
    assert.equal(s.remote.length, 1);
    const recovered = await s.services.readConversation(s.ctx, s.conversation.id);
    assert.equal(s.calls.filter((call) => call.method === 'POST').length, 1);
    assert(recovered.ok, `Remote Issue exists but recovery returned ${JSON.stringify(recovered)}; calls=${JSON.stringify(s.calls)}`);
  } finally { s.journal.close(); }
});

await check('R2: renewed approval can save after expiry before any remote write', async () => {
  const s = await fixture();
  try {
    const approval = await s.approve();
    const originalClaim = s.journal.claim.bind(s.journal);
    s.journal.claim = (operation) => {
      const claimed = originalClaim(operation);
      s.expireApproval();
      return claimed;
    };
    const first = await s.services.saveConversation(s.ctx, s.conversation, approval);
    assert(!first.ok && first.error.dataState === 'not_written');
    assert.equal(s.remote.length, 0);
    s.journal.claim = originalClaim;
    const retried = await s.services.saveConversation(s.ctx, s.conversation, await s.approve());
    assert(retried.ok, `Confirmed zero-write rejection became permanent unknown: ${JSON.stringify(retried)}; operation=${JSON.stringify(s.journal.conversation(s.ctx.workspaceId, s.conversation.id))}`);
    assert.equal(s.remote.length, 1);
  } finally { s.journal.close(); }
});

await check('R3: payload rejected before transport does not leave an unknown claim', async () => {
  const s = await fixture();
  try {
    s.conversation.segments[0]!.text = 'x'.repeat(1_000_001);
    s.conversation.contentHash = await hashConversation(s.conversation);
    const result = await s.services.saveConversation(s.ctx, s.conversation, await s.approve());
    assert(!result.ok && result.error.code === 'VALIDATION' && result.error.dataState === 'not_written');
    assert.equal(s.calls.length, 0);
    const claim = s.journal.conversation(s.ctx.workspaceId, s.conversation.id);
    assert(!claim || !['unknown', 'inflight'].includes(claim.state), `Zero network calls but journal contains ${JSON.stringify(claim)}`);
  } finally { s.journal.close(); }
});

if (process.argv.includes('--dev-server')) {
  await check('R4: local operation SQLite is not downloadable without authentication', async () => {
    const origin = new URL(process.env.REVIEW_WEB_ORIGIN ?? 'http://127.0.0.1:4312');
    assert.equal(origin.hostname, '127.0.0.1', 'Review HTTP requests must remain on loopback');
    assert.equal(origin.protocol, 'http:');
    assert.equal(origin.username + origin.password, '');
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/node-one-review-fixture-'));
    const file = join(directory, 'operations.sqlite');
    const sentinel = 'fixture-review-approval-only';
    try {
      const journal = new OperationJournal(file, { fixture: true });
      try {
        const approval: Approval = {
          id: sentinel, actorId: 'fixture-actor', workspaceId: 'fixture-workspace',
          purpose: 'save_conversation', objectIds: ['fixture-conversation'], contentHash: 'fixture-hash',
          baseRevision: 'new', approvedAt: '2026-09-05T06:00:00Z', expiresAt: '2026-09-05T06:15:00Z',
        };
        journal.recordApproval(approval);
      } finally { journal.close(); }
      const path = relative(resolve('.'), file).split('/').map(encodeURIComponent).join('/');
      const response = await fetch(new URL(`/${path}`, origin), { redirect: 'error', signal: AbortSignal.timeout(5_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const sqlite = bytes.subarray(0, 16).toString() === 'SQLite format 3\0';
      const approvalVisible = bytes.includes(Buffer.from(sentinel));
      assert(!(response.ok && (sqlite || approvalVisible)), `Unauthenticated HTTP ${response.status}; sqliteHeader=${sqlite}; fixtureApprovalVisible=${approvalVisible}`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `\n  ${result.detail}` : ''}`);
console.log(`Review checks: ${results.filter((result) => result.passed).length}/${results.length} passed. All CNB operations were fixture-only.`);
if (results.some((result) => !result.passed)) process.exitCode = 1;

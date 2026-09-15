import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperationJournal } from './journal';
import type { Approval } from '../contracts/domain';

describe('W05 durable operation metadata', () => {
  it('preserves claims and revoked approvals across database reopen with private file permissions', () => {
    mkdirSync('.local', { recursive: true });
    const directory = mkdtempSync(resolve('.local/journal-fixture-'));
    const file = join(directory, 'operations.sqlite');
    const approval: Approval = { id: 'a1', actorId: 'u1', workspaceId: 'w1', purpose: 'save_conversation', objectIds: ['c1'], contentHash: 'fixture-hash', baseRevision: 'new', approvedAt: '2026-09-05T00:00:00Z', expiresAt: '2026-09-05T00:15:00Z' };
    try {
      let journal = new OperationJournal(file);
      journal.recordApproval(approval);
      journal.revokeApproval('a1');
      const operation = { workspaceId: 'w1', objectId: 'c1', actorId: 'u1', contentHash: 'fixture-hash', state: 'unknown' as const };
      expect(journal.claim(operation)).toBe(true);
      const commit = { workspaceId: 'w1', objectId: 'change1', actorId: 'u1', contentHash: 'fixture-hash', baseRevision: 'a'.repeat(40),
        state: 'unknown' as const, branch: 'main', message: 'metadata-only', documentHash: 'fixture-document-hash', revision: 'b'.repeat(40), stagingKey: 'c'.repeat(64) };
      expect(journal.claimCommit(commit)).toBe(true);
      journal.close();
      journal = new OperationJournal(file);
      expect(journal.claim(operation)).toBe(false);
      expect(journal.conversation('w1', 'c1')).toEqual(operation);
      expect(journal.conversation('w2', 'c1')).toBeUndefined();
      expect(journal.claimCommit(commit)).toBe(false);
      expect(journal.commit('w1', 'change1')).toEqual(commit);
      expect(journal.commit('w2', 'change1')).toBeUndefined();
      expect(journal.approval('a1')).toEqual({ value: approval, revoked: true });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      journal.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('forbids accidental memory mode and storage outside the private project directory', () => {
    expect(() => new OperationJournal(':memory:')).toThrow('fixture-only');
    expect(() => new OperationJournal('/tmp/unsafe.sqlite')).toThrow('.local');
  });
  it('records storage mode across reopen and prevents fixture data being opened as live state', () => {
    mkdirSync('.local', { recursive: true }); const directory = mkdtempSync(resolve('.local/mode-fixture-')), file = join(directory, 'state.sqlite');
    try {
      const journal = new OperationJournal(file, { fixture: true }); journal.close();
      expect(() => new OperationJournal(file)).toThrow('cannot be mixed');
      new OperationJournal(file, { fixture: true }).close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('clears expired private payloads atomically, preserves metadata, and enforces aggregate capacity', () => {
    const journal = new OperationJournal(':memory:', { fixture: true });
    try {
      for (const kind of ['candidates', 'handoff']) journal.putRecord('w1', 'u1', kind, 'p1', { state: 'available', expiresAt: '2000-01-01T00:00:00Z', contentHash: 'original-hash',
        ...(kind === 'candidates' ? { candidates: ['private candidate text'] } : { document: { private: 'private draft text' }, source: { text: 'private quote' }, spans: ['private span'] }) }, null);
      expect(journal.privatePayloadFits('w1', 'u1', 25_000_001)).toBe(false);
      expect(journal.expirePrivatePayloads()).toBe(2); expect(journal.expirePrivatePayloads()).toBe(0);
      expect(JSON.stringify(journal.records('w1', 'u1', 'handoff'))).not.toContain('private draft text');
      expect(JSON.stringify(journal.records('w1', 'u1', 'candidates'))).not.toContain('private candidate text');
      expect(journal.record('w1', 'u1', 'handoff', 'p1')).toMatchObject({ version: 2, value: { contentHash: 'original-hash', document: null, source: null, spans: [] } });
    } finally { journal.close(); }
  });
});

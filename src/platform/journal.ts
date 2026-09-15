import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, constants, mkdirSync, openSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { ApprovalSchema, type Approval } from '../contracts/domain';
import { AuditEventSchema, AuditOperationSchema, type AuditOperation } from '../contracts/audit';

const OperationSchema = z.object({ workspaceId: z.string(), objectId: z.string(), actorId: z.string(), contentHash: z.string(), state: z.enum(['inflight', 'unknown', 'done']), issueNumber: z.number().int().positive().optional() }).strict();
export type ConversationOperation = z.infer<typeof OperationSchema>;
const CommitOperationSchema = z.object({
  workspaceId: z.string(), objectId: z.string(), actorId: z.string(), contentHash: z.string(), baseRevision: z.string(),
  state: z.enum(['inflight', 'sending', 'unknown', 'done', 'conflict']), branch: z.string(), message: z.string(),
  documentHash: z.string(), revision: z.string().optional(), stagingKey: z.string().optional(), objectIds: z.array(z.string()).optional(),
}).strict();
export type CommitOperation = z.infer<typeof CommitOperationSchema>;
export interface StoredRecord { value: unknown; version: number; updatedAt?: string }

// Private operation state and bounded temporary candidates live here. CNB/Git remain the conversation/knowledge fact sources.
export class OperationJournal {
  private readonly db: DatabaseSync;
  readonly fixture: boolean;

  constructor(file: string, options: { fixture?: boolean } = {}) {
    this.fixture = options.fixture ?? false;
    if (file === ':memory:' && !options.fixture) throw new Error('In-memory operation storage is fixture-only');
    if (file !== ':memory:') {
      const root = resolve('.local');
      const target = resolve(file);
      const location = relative(root, target);
      if (!location || location.startsWith('..') || isAbsolute(location) || !target.endsWith('.sqlite')) throw new Error('Operation storage must be a .local SQLite file');
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const parent = relative(root, realpathSync(dirname(target)));
      if (parent.startsWith('..') || isAbsolute(parent)) throw new Error('Operation storage cannot traverse symlinks');
      chmodSync(dirname(target), 0o700);
      const fd = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      if (!lstatSync(target).isFile()) throw new Error('Invalid operation storage');
      chmodSync(target, 0o600);
      file = target;
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 2) { this.db.close(); throw new Error('Operation schema is newer than this application'); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, value TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS conversations (workspace TEXT NOT NULL, object_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (workspace, object_id));
      CREATE TABLE IF NOT EXISTS commits (workspace TEXT NOT NULL, object_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (workspace, object_id));
      CREATE TABLE IF NOT EXISTS records (workspace TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace, actor, kind, object_id));
      CREATE TABLE IF NOT EXISTS retrieval_blocks (workspace TEXT NOT NULL, object_id TEXT NOT NULL, plan_id TEXT NOT NULL, PRIMARY KEY (workspace, object_id));
      CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, object_ids TEXT NOT NULL, occurred_at TEXT NOT NULL, outcome TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS storage_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const mode = this.fixture ? 'fixture' : 'live';
    const previous = this.db.prepare("SELECT value FROM storage_metadata WHERE name = 'mode'").get();
    if (previous && previous.value !== mode) { this.db.close(); throw new Error('Fixture and live operation storage cannot be mixed'); }
    this.db.prepare("INSERT OR IGNORE INTO storage_metadata(name, value) VALUES ('mode', ?)").run(mode);
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS audit_operations (audit_id INTEGER PRIMARY KEY REFERENCES audit_events(id),
        kind TEXT NOT NULL, operation_id TEXT NOT NULL); PRAGMA user_version = 2;`);
    });
  }

  recordApproval(approval: Approval): void {
    this.db.prepare('INSERT INTO approvals(id, value) VALUES (?, ?)').run(approval.id, JSON.stringify(ApprovalSchema.parse(approval)));
  }

  approval(id: string): { value: Approval; revoked: boolean } | undefined {
    const row = this.db.prepare('SELECT value, revoked FROM approvals WHERE id = ?').get(id);
    return row ? { value: ApprovalSchema.parse(JSON.parse(String(row.value))), revoked: Boolean(row.revoked) } : undefined;
  }

  revokeApproval(id: string): void { this.db.prepare('UPDATE approvals SET revoked = 1 WHERE id = ?').run(id); }
  revokeAllApprovals(): void { this.db.prepare('UPDATE approvals SET revoked = 1 WHERE revoked = 0').run(); }

  matchingKnowledgeApprovals(workspace: string, actor: string, hash: string): Approval[] {
    return this.db.prepare(`SELECT value FROM approvals WHERE json_extract(value, '$.workspaceId') = ? AND json_extract(value, '$.actorId') = ?
      AND json_extract(value, '$.purpose') = 'commit_knowledge' AND json_extract(value, '$.contentHash') = ? LIMIT 2`).all(workspace, actor, hash)
      .map((row) => ApprovalSchema.parse(JSON.parse(String(row.value))));
  }
  hasUnmappedKnowledgeApprovals(workspace: string, actor: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM approvals a WHERE json_extract(a.value, '$.workspaceId') = ? AND json_extract(a.value, '$.actorId') = ?
      AND json_extract(a.value, '$.purpose') = 'commit_knowledge' AND NOT EXISTS
      (SELECT 1 FROM records r WHERE r.workspace = ? AND r.actor = '@workspace' AND r.kind = 'knowledge_approval' AND json_extract(r.value, '$.approvalId') = a.id) LIMIT 1`).get(workspace, actor, workspace));
  }

  claim(operation: ConversationOperation): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO conversations(workspace, object_id, value) VALUES (?, ?, ?)').run(operation.workspaceId, operation.objectId, JSON.stringify(OperationSchema.parse(operation))).changes) === 1;
  }

  conversation(workspaceId: string, objectId: string): ConversationOperation | undefined {
    const row = this.db.prepare('SELECT value FROM conversations WHERE workspace = ? AND object_id = ?').get(workspaceId, objectId);
    return row ? OperationSchema.parse(JSON.parse(String(row.value))) : undefined;
  }

  update(operation: ConversationOperation): void {
    this.db.prepare('UPDATE conversations SET value = ? WHERE workspace = ? AND object_id = ?').run(JSON.stringify(OperationSchema.parse(operation)), operation.workspaceId, operation.objectId);
  }

  releaseUnsent(operation: ConversationOperation): void {
    this.db.prepare('DELETE FROM conversations WHERE workspace = ? AND object_id = ? AND value = ?')
      .run(operation.workspaceId, operation.objectId, JSON.stringify(OperationSchema.parse(operation)));
  }

  claimCommit(operation: CommitOperation): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO commits(workspace, object_id, value) VALUES (?, ?, ?)')
      .run(operation.workspaceId, operation.objectId, JSON.stringify(CommitOperationSchema.parse(operation))).changes) === 1;
  }

  commit(workspaceId: string, objectId: string): CommitOperation | undefined {
    const row = this.db.prepare('SELECT value FROM commits WHERE workspace = ? AND object_id = ?').get(workspaceId, objectId);
    return row ? CommitOperationSchema.parse(JSON.parse(String(row.value))) : undefined;
  }

  updateCommit(operation: CommitOperation): void {
    this.db.prepare('UPDATE commits SET value = ? WHERE workspace = ? AND object_id = ?')
      .run(JSON.stringify(CommitOperationSchema.parse(operation)), operation.workspaceId, operation.objectId);
  }

  finishCommit(operation: CommitOperation): CommitOperation {
    return this.transaction(() => {
      const current = this.commit(operation.workspaceId, operation.objectId);
      if (!current || current.actorId !== operation.actorId || current.contentHash !== operation.contentHash || current.baseRevision !== operation.baseRevision
        || current.documentHash !== operation.documentHash || current.revision !== operation.revision || !current.revision) throw Error('Original commit binding changed');
      if (current.state === 'done') return current;
      if (!['sending', 'unknown'].includes(current.state)) throw Error('Original commit was not sent');
      const done: CommitOperation = { ...current, state: 'done' };
      this.updateCommit(done);
      this.addAudit(done.workspaceId, done.actorId, 'commit_knowledge', done.objectIds ?? [], 'done', { kind: 'knowledge', id: done.objectId });
      return done;
    });
  }

  releaseUnsentCommit(operation: CommitOperation): void {
    if (operation.state !== 'inflight') throw new Error('Cannot release a potentially sent commit');
    this.db.prepare('DELETE FROM commits WHERE workspace = ? AND object_id = ? AND value = ?')
      .run(operation.workspaceId, operation.objectId, JSON.stringify(CommitOperationSchema.parse(operation)));
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  record(workspace: string, actor: string, kind: string, id: string): StoredRecord | undefined {
    const row = this.db.prepare('SELECT value, version, updated_at FROM records WHERE workspace = ? AND actor = ? AND kind = ? AND object_id = ?').get(workspace, actor, kind, id);
    return row ? { value: JSON.parse(String(row.value)), version: Number(row.version), updatedAt: String(row.updated_at) } : undefined;
  }

  putRecord(workspace: string, actor: string, kind: string, id: string, value: unknown, expected: number | null): boolean {
    const encoded = JSON.stringify(value);
    if (!encoded || Buffer.byteLength(encoded) > 1_000_000) throw new Error('Local record exceeds budget');
    if (expected === null) return Number(this.db.prepare('INSERT OR IGNORE INTO records(workspace, actor, kind, object_id, value, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(workspace, actor, kind, id, encoded, new Date().toISOString()).changes) === 1;
    return Number(this.db.prepare('UPDATE records SET value = ?, version = version + 1, updated_at = ? WHERE workspace = ? AND actor = ? AND kind = ? AND object_id = ? AND version = ?')
      .run(encoded, new Date().toISOString(), workspace, actor, kind, id, expected).changes) === 1;
  }

  records(workspace: string, actor: string, kind: string): { id: string; value: unknown; version: number; updatedAt: string }[] {
    return this.db.prepare('SELECT object_id, value, version, updated_at FROM records WHERE workspace = ? AND actor = ? AND kind = ? ORDER BY object_id LIMIT 10000').all(workspace, actor, kind)
      .map((row) => ({ id: String(row.object_id), value: JSON.parse(String(row.value)), version: Number(row.version), updatedAt: String(row.updated_at) }));
  }
  extractionOperationIds(workspace: string, actor: string, conversationId: string): string[] {
    return this.db.prepare(`SELECT operation.object_id AS object_id
      FROM records AS operation
      JOIN records AS constraint_record ON constraint_record.workspace = operation.workspace
        AND constraint_record.actor = ? AND constraint_record.kind = 'model_constraint'
        AND constraint_record.object_id = operation.object_id
      WHERE operation.workspace = ? AND operation.actor = '@workspace' AND operation.kind = 'model_operation'
        AND json_extract(constraint_record.value, '$.purpose') = 'extract'
        AND json_extract(constraint_record.value, '$.conversationId') = ?
      ORDER BY operation.updated_at, operation.object_id`).all(actor, workspace, conversationId).map((row) => String(row.object_id));
  }
  modelBudgetUsage(workspace: string, date: string, now: number): { daily: number; active: number } {
    const row = this.db.prepare(`SELECT SUM(CASE WHEN json_extract(value, '$.date') = ? THEN 1 ELSE 0 END) AS daily,
      SUM(CASE WHEN json_extract(value, '$.state') = 'sending' AND json_extract(value, '$.expiresAt') > ? THEN 1 ELSE 0 END) AS active
      FROM records WHERE workspace = ? AND actor = '@workspace' AND kind = 'model_operation'`).get(date, now, workspace);
    return { daily: Number(row?.daily ?? 0), active: Number(row?.active ?? 0) };
  }

  hasActiveIntelligenceTraining(workspace: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM records WHERE workspace = ? AND kind = 'intelligence_run'
      AND json_extract(value, '$.state') = 'running' LIMIT 1`).get(workspace));
  }
  hasIntelligenceTrainingIdentity(workspace: string, id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM records WHERE workspace = ? AND kind = 'intelligence_run' AND lower(object_id) = lower(?) LIMIT 1`).get(workspace, id));
  }

  privatePayloadFits(workspace: string, actor: string, addedBytes: number, previousBytes = 0, replacing = false): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes FROM records
      WHERE workspace = ? AND actor = ? AND kind IN ('candidates', 'handoff', 'task', 'handoff_operation') AND json_extract(value, '$.state') = 'available'`).get(workspace, actor);
    return Number(row?.count ?? 0) + (replacing ? 0 : 1) <= 1000 && Number(row?.bytes ?? 0) - previousBytes + addedBytes <= 25_000_000;
  }
  reviewPayloadFits(workspace: string, addedBytes: number, previousBytes = 0, replacing = false): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes FROM records
      WHERE workspace = ? AND actor = '@workspace' AND kind IN ('review_question', 'review_attempt')
      AND (kind = 'review_question' OR json_extract(value, '$.state') = 'available')`).get(workspace);
    return Number(row?.count ?? 0) + (replacing ? 0 : 1) <= 10_000 && Number(row?.bytes ?? 0) - previousBytes + addedBytes <= 50_000_000;
  }
  evidencePayloadFits(workspace: string, addedBytes: number): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes FROM records
      WHERE workspace = ? AND actor = '@workspace' AND kind = 'evidence'`).get(workspace);
    return Number(row?.count ?? 0) < 10_000 && Number(row?.bytes ?? 0) + addedBytes <= 50_000_000;
  }
  expirePrivatePayloads(now = new Date().toISOString()): number {
    return this.transaction(() => {
      const candidates = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.candidates', json('[]')),
        version = version + 1, updated_at = ? WHERE kind = 'candidates' AND json_extract(value, '$.state') = 'available'
        AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      const drafts = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.document', NULL, '$.source', NULL, '$.spans', json('[]')),
        version = version + 1, updated_at = ? WHERE kind = 'handoff' AND json_extract(value, '$.state') = 'available'
        AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      const tasks = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.task', NULL),
        version = version + 1, updated_at = ? WHERE kind = 'task' AND json_extract(value, '$.state') = 'available'
        AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      const operations = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.snapshot', NULL, '$.sourceSpans', json('[]')),
        version = version + 1, updated_at = ? WHERE kind = 'handoff_operation' AND json_extract(value, '$.state') = 'available'
        AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      const governance = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.payload', NULL),
        version = version + 1, updated_at = ? WHERE kind = 'governance_operation' AND json_extract(value, '$.state') = 'available'
        AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      const reviews = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.attempt', NULL),
        version = version + 1, updated_at = ? WHERE kind = 'review_attempt' AND json_extract(value, '$.state') = 'available'
        AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      const questions = this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.question', NULL),
        version = version + 1, updated_at = ? WHERE kind = 'review_question' AND json_extract(value, '$.question') IS NOT NULL
        AND COALESCE(julianday(json_extract(value, '$.expiresAt')), julianday(updated_at) + 30) <= julianday(?)`).run(now, now);
      const exposure = this.db.prepare(`DELETE FROM records WHERE kind = 'review_exposure' AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now);
      const recovery = this.db.prepare(`DELETE FROM records WHERE kind = 'recovery_anchor' AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now);
      const chats = this.db.prepare(`UPDATE records SET value = 'null', version = version + 1, updated_at = ? WHERE kind = 'intelligence_chat'
        AND json_extract(value, '$.expiresAt') IS NOT NULL AND julianday(json_extract(value, '$.expiresAt')) <= julianday(?)`).run(now, now);
      return Number(candidates.changes) + Number(drafts.changes) + Number(tasks.changes) + Number(operations.changes) + Number(governance.changes) + Number(reviews.changes) + Number(questions.changes) + Number(exposure.changes) + Number(recovery.changes) + Number(chats.changes);
    });
  }

  block(workspace: string, ids: string[], planId: string): void {
    for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO retrieval_blocks(workspace, object_id, plan_id) VALUES (?, ?, ?)').run(workspace, id, planId);
  }
  eraseReviewPayloads(workspace: string, ids: string[]): void {
    for (const id of ids) {
      this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.question', NULL), version = version + 1
        WHERE workspace = ? AND kind = 'review_question' AND (json_extract(value, '$.question.id') = ? OR json_extract(value, '$.question.nodeRef.objectId') = ?)`).run(workspace, id, id);
      this.db.prepare(`UPDATE records SET value = json_set(value, '$.state', 'expired', '$.attempt', NULL), version = version + 1
        WHERE workspace = ? AND kind = 'review_attempt' AND (object_id = ? OR json_extract(value, '$.attempt.taskId') = ?
        OR json_extract(value, '$.attempt.question.id') = ? OR json_extract(value, '$.attempt.question.nodeRef.objectId') = ?)`).run(workspace, id, id, id, id);
      this.db.prepare(`DELETE FROM records WHERE workspace = ? AND kind = 'review_exposure' AND json_extract(value, '$.nodeRef.objectId') = ?`).run(workspace, id);
    }
  }
  blocked(workspace: string): string[] {
    return this.db.prepare('SELECT object_id FROM retrieval_blocks WHERE workspace = ? ORDER BY object_id').all(workspace).map((row) => String(row.object_id));
  }
  addAudit(workspace: string, actor: string, action: string, objectIds: string[], outcome: string, operation?: AuditOperation): void {
    const parsed = operation ? AuditOperationSchema.parse(operation) : undefined;
    if (parsed) {
      const original = parsed.kind === 'knowledge' ? this.commit(workspace, parsed.id)
        : this.record(workspace, parsed.kind === 'evidence' ? '@workspace' : actor,
          parsed.kind === 'settings' ? 'settings_receipt' : parsed.kind === 'delete' ? 'delete_report' : 'evidence_receipt', parsed.id)?.value;
      const owner = z.object({ actorId: z.string(), workspaceId: z.string() }).safeParse(original);
      const identity = z.record(z.string(), z.unknown()).safeParse(original);
      const idKey = parsed.kind === 'knowledge' ? 'objectId' : parsed.kind === 'settings' ? 'approvalId' : parsed.kind === 'delete' ? 'planId' : 'operationId';
      if (!original || (parsed.kind !== 'delete' && (!owner.success || owner.data.actorId !== actor || owner.data.workspaceId !== workspace))
        || !identity.success || identity.data[idKey] !== parsed.id
        || (parsed.kind === 'knowledge' && this.commit(workspace, parsed.id)?.state !== 'done')) throw Error('Audit association requires the original verified receipt');
    }
    // SAVEPOINT keeps an event and its link atomic, both inside receipt transactions and for standalone events.
    this.db.exec('SAVEPOINT audit_event');
    try {
      const event = this.db.prepare('INSERT INTO audit_events(workspace, actor, action, object_ids, occurred_at, outcome) VALUES (?, ?, ?, ?, ?, ?)')
        .run(workspace, actor, action, JSON.stringify(objectIds), new Date().toISOString(), outcome);
      if (parsed) this.db.prepare('INSERT INTO audit_operations(audit_id,kind,operation_id) VALUES (?,?,?)').run(event.lastInsertRowid, parsed.kind, parsed.id);
      this.db.exec('RELEASE audit_event');
    } catch (error) { this.db.exec('ROLLBACK TO audit_event; RELEASE audit_event'); throw error; }
  }
  audit(workspace: string, actor: string) {
    return this.db.prepare(`SELECT a.action, a.object_ids, a.occurred_at, a.outcome, o.kind, o.operation_id FROM audit_events a
      LEFT JOIN audit_operations o ON o.audit_id = a.id WHERE a.workspace = ? AND a.actor = ? ORDER BY a.id DESC LIMIT 1000`).all(workspace, actor)
      .map((row) => AuditEventSchema.parse({ action: String(row.action), objectIds: JSON.parse(String(row.object_ids)), occurredAt: String(row.occurred_at), outcome: String(row.outcome),
        ...(row.kind === null ? {} : { operation: { kind: row.kind, id: row.operation_id } }) }));
  }

  close(): void { this.db.close(); }
}

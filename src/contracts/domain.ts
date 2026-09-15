import { z } from 'zod';

export const CONTRACT_VERSION = '1.31.0' as const;
export const Id = z.string().min(1).max(160);
export const GitRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const Timestamp = z.string().datetime({ offset: true });
export const Mode = z.enum(['unconfigured', 'fixture', 'live']);
export const VersionRefSchema = z.object({
  workspaceId: Id, objectId: Id, revision: Id,
}).strict();
export type VersionRef = z.infer<typeof VersionRefSchema>;

export const SourceSpanSchema = z.object({
  id: Id, conversationId: Id, segmentId: Id,
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  quote: z.string().min(1), contentHash: Id,
}).strict().refine((s) => s.end > s.start, 'Invalid source range');

export const SourceRecordSchema = z.object({
  id: Id, kind: z.enum(['conversation', 'official', 'paper', 'user_observation', 'ai_inference']),
  title: z.string().min(1), url: z.string().url().optional(),
  excerpt: z.string(), accessedAt: Timestamp,
  support: z.enum(['supports', 'partial', 'does_not_support', 'unverified']),
  supportedClaim: z.string(), limitation: z.string(),
}).strict();
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const ConversationSchema = z.object({
  id: Id, workspaceId: Id, taskId: Id,
  origin: z.enum(['cnb_issue', 'paste', 'manual']),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.string().url().optional(),
  sourceAlreadyPersisted: z.boolean(),
  segments: z.array(z.object({ id: Id, role: z.enum(['user', 'assistant', 'source']), text: z.string() }).strict()),
  contentHash: Id, createdAt: Timestamp,
  state: z.enum(['preview', 'approved', 'saving', 'saved', 'unknown', 'failed']),
}).strict();
export type Conversation = z.infer<typeof ConversationSchema>;

export const CandidateSchema = z.object({
  id: Id, conversationId: Id,
  title: z.string().min(1).max(120), question: z.string().min(1),
  claim: z.string().min(1),
  kind: z.enum(['concept', 'fact', 'claim', 'principle', 'method', 'decision', 'question']),
  whyKeep: z.string().min(1), spans: z.array(SourceSpanSchema).min(1),
  sources: z.array(SourceRecordSchema), uncertainties: z.array(z.string()),
  modelId: Id, promptVersion: Id, generatedAt: Timestamp,
  state: z.literal('proposed'),
}).strict();
export type Candidate = z.infer<typeof CandidateSchema>;

export const ConditionSchema = z.object({
  id: Id, text: z.string().min(1),
  status: z.enum(['confirmed', 'unknown', 'rejected']),
  evidenceIds: z.array(Id), confirmedBy: Id.optional(),
}).strict();

export const KnowledgeNodeSchema = z.object({
  id: Id, workspaceId: Id, schemaVersion: z.literal(1), revision: Id,
  title: z.string().min(1), question: z.string().min(1),
  humanStatement: z.string().min(1),
  authorship: z.enum(['human_written', 'human_edited', 'ai_accepted']),
  candidateIds: z.array(Id), conversationId: Id,
  kind: CandidateSchema.shape.kind,
  conditions: z.array(ConditionSchema), boundaries: z.array(z.string()),
  sources: z.array(SourceRecordSchema),
  confirmation: z.enum(['draft', 'confirmed']),
  evidenceStatus: z.enum(['unverified', 'partial', 'supported', 'disputed']),
  lifecycle: z.enum(['active', 'needs_review', 'superseded', 'withdrawn']),
  confirmedBy: Id.optional(), confirmedAt: Timestamp.optional(),
  updatedAt: Timestamp,
}).strict().superRefine((n, ctx) => {
  if (n.confirmation === 'confirmed' && (!n.confirmedBy || !n.confirmedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Confirmation requires actor and time' });
  }
});
export type KnowledgeNode = z.infer<typeof KnowledgeNodeSchema>;

export const RelationSchema = z.object({
  id: Id, workspaceId: Id,
  source: VersionRefSchema, target: VersionRefSchema,
  type: z.enum(['supports', 'depends_on', 'contradicts', 'supersedes']),
  rationale: z.string().min(1), evidenceIds: z.array(Id),
  state: z.enum(['proposed', 'confirmed', 'rejected', 'withdrawn']),
  proposedBy: Id, confirmedBy: Id.optional(), confirmedAt: Timestamp.optional(),
  updatedAt: Timestamp,
}).strict().superRefine((r, ctx) => {
  if (r.source.workspaceId !== r.workspaceId || r.target.workspaceId !== r.workspaceId) {
    ctx.addIssue({ code: 'custom', message: 'Cross-workspace relation is forbidden in v1' });
  }
  if (r.state === 'confirmed' && (!r.confirmedBy || !r.confirmedAt || !r.evidenceIds.length)) {
    ctx.addIssue({ code: 'custom', message: 'Confirmed relation requires evidence, actor and time' });
  }
});
export type Relation = z.infer<typeof RelationSchema>;

export const TaskConditionCheckSchema = z.object({
  nodeRef: VersionRefSchema.extend({ revision: GitRevisionSchema }), conditionId: Id,
  status: z.enum(['satisfied', 'not_satisfied', 'unknown']), confirmedBy: Id.optional(),
}).strict().refine((check) => (check.status === 'unknown') === (check.confirmedBy === undefined), 'Definite task checks require an actor; unknown checks cannot claim confirmation');
export type TaskConditionCheck = z.infer<typeof TaskConditionCheckSchema>;
const TaskConditionChecksSchema = z.array(TaskConditionCheckSchema).max(200).superRefine((checks, ctx) => {
  const seen = new Set<string>();
  for (const check of checks) {
    const key = JSON.stringify([check.nodeRef.workspaceId, check.nodeRef.objectId, check.conditionId]);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'Task checks duplicate a condition binding' });
    seen.add(key);
  }
});

export const TaskContextSchema = z.object({
  id: Id, workspaceId: Id, question: z.string().min(1),
  constraints: z.array(z.object({ id: Id, text: z.string(), confirmedBy: Id.optional() }).strict()),
  conditionChecks: TaskConditionChecksSchema.optional(),
  mode: z.enum(['assisted', 'independent']),
  sourceIssueNumber: z.number().int().positive().optional(),
  updatedAt: Timestamp,
}).strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const ApprovalSchema = z.object({
  id: Id, actorId: Id, workspaceId: Id,
  purpose: z.enum(['model_input', 'save_conversation', 'commit_knowledge', 'save_evidence', 'delete', 'export', 'settings', 'demo_export', 'update_index']),
  objectIds: z.array(Id), contentHash: Id, baseRevision: Id,
  approvedAt: Timestamp, expiresAt: Timestamp,
}).strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const ChangeSetSchema = z.object({
  id: Id, workspaceId: Id, baseRevision: Id,
  nodes: z.array(KnowledgeNodeSchema), relations: z.array(RelationSchema),
  withdrawnIds: z.array(Id), reason: z.string().min(1), contentHash: Id,
}).strict();
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export const EvidenceKnowledgeSchema = z.object({ id: Id, revision: GitRevisionSchema, title: z.string().min(1), humanStatement: z.string().min(1),
  conditions: z.array(ConditionSchema).max(100), boundaries: z.array(z.string()).max(100), evidenceStatus: KnowledgeNodeSchema.shape.evidenceStatus }).strict();
export const EvidencePathSchema = z.object({ seedId: Id, relationIds: z.array(Id).max(40), nodeIds: z.array(Id).min(1).max(41), reason: z.string().max(4000) }).strict();
export const EvidenceUseContextSchema = z.object({ task: TaskContextSchema, snapshotRevision: GitRevisionSchema,
  knowledge: z.array(EvidenceKnowledgeSchema).min(1).max(100), relations: z.array(RelationSchema).max(40), paths: z.array(EvidencePathSchema).max(100),
  reason: z.string().max(4000), retrievalContext: z.object({ queryId: Id.nullable(), coverage: z.enum(['current', 'stale', 'partial', 'unavailable']),
    missingConditions: z.array(z.string().max(4000)).max(100), warnings: z.array(z.string().max(4000)).max(100), trust: z.literal('client_preview_only') }).strict(),
}).strict();
export const EvidenceOutcomeSchema = z.object({ useRecordId: Id, status: z.enum(['succeeded', 'failed', 'unclear']), summary: z.string().min(1).max(4000),
  failureReason: z.string().max(4000), verification: z.literal('self_reported') }).strict();

export const EvidenceRecordSchema = z.object({
  id: Id, workspaceId: Id, taskId: Id,
  kind: z.enum(['use', 'recall', 'near_transfer', 'outcome']),
  nodeRefs: z.array(VersionRefSchema), relationRefs: z.array(Id),
  decision: z.enum(['adopt', 'reject', 'verify_later']).optional(),
  answer: z.string(), answerVisible: z.boolean(), hintLevel: z.number().int().min(0).max(3),
  selfConfidence: z.enum(['low', 'medium', 'high', 'skipped']),
  result: z.enum(['unverified', 'self_reported', 'partial', 'met_rubric', 'not_met', 'invalid_question']),
  rubricVersion: Id.optional(), reviewedBy: Id.optional(), recordedAt: Timestamp,
  useContext: EvidenceUseContextSchema.optional(), outcome: EvidenceOutcomeSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if ((record.kind === 'outcome') !== (record.outcome !== undefined) || (record.useContext && record.kind !== 'use'))
    ctx.addIssue({ code: 'custom', message: 'Evidence context does not match its kind' });
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export interface Workspace { id: string; slug: string; visibility: 'private' | 'public'; mode: z.infer<typeof Mode> }
export interface KnowledgeSnapshot {
  workspaceId: string; revision: string; nodes: KnowledgeNode[]; relations: Relation[];
  excludedIds: string[]; generatedAt: string;
}
export interface RetrievalRequest { task: TaskContext; query: string; confirmedOnly: boolean }
export interface RetrievalResult {
  queryId: string; snapshotRevision: string;
  groups: { eligible: KnowledgeNode[]; conditional: KnowledgeNode[]; conflicts: KnowledgeNode[]; excludedIds: string[] };
  paths: { seedId: string; relationIds: string[]; nodeIds: string[]; reason: string }[];
  answer: { text: string; citations: { nodeRef: VersionRef; sourceId: string; quote: string }[] } | null;
  missingConditions: string[]; warnings: string[];
  coverage: 'current' | 'stale' | 'partial' | 'unavailable';
}
export interface HandoffDraft {
  id: string; conversationId: string; candidateId: string | null;
  node: KnowledgeNode; relations: Relation[]; baseRevision: string;
}
export interface DeletePlan {
  id: string; workspaceId: string; objectIds: string[]; contentHash: string; baseRevision: string;
  layers: { name: string; supported: boolean; consequence: string; reversible: boolean; capability?: 'supported' | 'unsupported' | 'unknown' }[];
}
export interface DeleteReport { planId: string; retrievalBlocked: boolean; layers: { name: string; state: 'done' | 'pending' | 'unsupported' | 'failed' | 'unknown'; detail: string }[] }
export interface Settings { aiExtraction: boolean; aiAnswer: boolean; aiReview: boolean; saveQueryHistory: boolean; reviewReminders: boolean }
export interface CommitReceipt { changeSetId: string; revision: string; commitUrl: string; indexing: 'pending' | 'current' | 'failed' }

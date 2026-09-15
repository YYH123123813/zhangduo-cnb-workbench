import type { Result, RequestContext } from './api';
import type { ConversationApprovalRequest, KnowledgeApprovalRequest, KnowledgeApprovalState, ApprovalRegistrationQuery, ApprovalRegistrationState } from './approval';
import type { GovernanceApprovalRequest, SettingsState, SettingsReceipt } from './governance';
import type { SemanticQueryResult } from './retrieval';
import type { ModelApprovalRequest, ModelCloseOperationRequest, ModelOperationReceipt } from './model';
import type { ExtractionDiscovery, ExtractionOperation } from './extraction';
import type { GovernanceOperationReceipt, GovernanceOperationSaveRequest, GovernanceOperationState } from './governance-operation';
import type { CandidateSaveOptions, CandidateState } from './candidates';
import type { DraftSaveOptions, DraftState, DraftReceipt, ReviewProgress } from './handoff';
import type { EvidenceApprovalRequest, EvidenceReceipt } from './evidence';
import type { TaskReceipt, TaskSaveRequest, TaskState } from './task-record';
import type { HandoffOperationReceipt, HandoffOperationSaveRequest, HandoffOperationState } from './handoff-operation';
import type { AuditEvent } from './audit';
import type { DemoExportExecutionRequest, DemoExportRecovery, DemoExportReceipt, DemoExportRequest } from './demo-export';
import type { OperationRecovery, OperationRecoveryQuery } from './operation-recovery';
import type { RecoveryAnchor, RecoveryAnchorRead, RecoveryAnchorRequest } from './recovery-anchor';
import type { IndexPreviewRequest, IndexPlan, IndexApprovalRequest, IndexExecutionRequest, IndexOperation, IndexStatus } from './indexing';
import type {
  ReviewAppealRequest, ReviewAttemptEventRequest, ReviewAttemptStartRequest, ReviewAttemptPublic,
  ReviewFeedbackRequest, ReviewOperationReceipt, ReviewOperationRecovery, ReviewQuestionPublic, ReviewQuestionQuery, ReviewRuntimeStatus,
} from './review-session';
import type {
  Approval, Candidate, ChangeSet, CommitReceipt, Conversation, DeletePlan, DeleteReport,
  EvidenceRecord, HandoffDraft, KnowledgeSnapshot, Settings, Workspace, VersionRef,
} from './domain';

// Feature modules receive ports; they never import another feature's implementation.
export interface Services {
  intelligenceCommand?(ctx: RequestContext, input: import('./intelligence').IntelligenceCommand): Promise<Result<unknown>>;
  previewIndexUpdate?(ctx: RequestContext, input: IndexPreviewRequest): Promise<Result<IndexPlan>>;
  approveIndexUpdate?(ctx: RequestContext, input: IndexApprovalRequest): Promise<Result<Approval>>;
  executeIndexUpdate?(ctx: RequestContext, input: IndexExecutionRequest): Promise<Result<IndexOperation>>;
  readIndexOperation?(ctx: RequestContext, operationId: string): Promise<Result<IndexOperation | null>>;
  listIndexOperations?(ctx: RequestContext): Promise<Result<IndexOperation[]>>;
  readIndexStatus?(ctx: RequestContext): Promise<Result<IndexStatus>>;
  saveRecoveryAnchor?(ctx: RequestContext, input: RecoveryAnchorRequest): Promise<Result<RecoveryAnchor>>;
  listRecoveryAnchors?(ctx: RequestContext): Promise<Result<RecoveryAnchor[]>>;
  readRecoveryAnchor?(ctx: RequestContext, id: string): Promise<Result<RecoveryAnchorRead | null>>;
  readReviewRuntime?(ctx: RequestContext): Promise<Result<ReviewRuntimeStatus>>;
  // Server-only observation of content about to be returned. There is deliberately no public write route.
  recordReviewExposure?(ctx: RequestContext, refs: VersionRef[]): Promise<Result<{ recorded: number }>>;
  saveHandoffOperation?(ctx: RequestContext, input: HandoffOperationSaveRequest): Promise<Result<HandoffOperationState>>;
  readHandoffOperation?(ctx: RequestContext, changeSetId: string): Promise<Result<HandoffOperationState>>;
  readHandoffOperationReceipt?(ctx: RequestContext, changeSetId: string): Promise<Result<HandoffOperationReceipt | null>>;
  saveTask?(ctx: RequestContext, input: TaskSaveRequest): Promise<Result<TaskState>>;
  readTaskState?(ctx: RequestContext, taskId: string): Promise<Result<TaskState>>;
  readTaskReceipt?(ctx: RequestContext, operationId: string): Promise<Result<TaskReceipt | null>>;
  approveEvidence?(ctx: RequestContext, input: EvidenceApprovalRequest): Promise<Result<Approval>>;
  readEvidence?(ctx: RequestContext, recordId: string): Promise<Result<EvidenceRecord | null>>;
  readEvidenceReceipt?(ctx: RequestContext, operationId: string): Promise<Result<EvidenceReceipt | null>>;
  readApprovalRegistration?(ctx: RequestContext, query: ApprovalRegistrationQuery): Promise<Result<ApprovalRegistrationState>>;
  approveConversation?(ctx: RequestContext, input: ConversationApprovalRequest): Promise<Result<Approval>>;
  approveKnowledge?(ctx: RequestContext, input: KnowledgeApprovalRequest): Promise<Result<Approval>>;
  readKnowledgeApproval?(ctx: RequestContext, changeSetId: string): Promise<Result<KnowledgeApprovalState>>;
  readCommit?(ctx: RequestContext, changeSetId: string): Promise<Result<CommitReceipt | null>>;
  approveGovernance?(ctx: RequestContext, input: GovernanceApprovalRequest): Promise<Result<Approval>>;
  approveDemoExport?(ctx: RequestContext, input: DemoExportRequest): Promise<Result<Approval>>;
  executeDemoExport?(ctx: RequestContext, input: DemoExportExecutionRequest): Promise<Result<DemoExportReceipt>>;
  readDemoExport?(ctx: RequestContext, operationId: string): Promise<Result<DemoExportRecovery>>;
  readOperationRecovery?(ctx: RequestContext, input: OperationRecoveryQuery): Promise<Result<OperationRecovery>>;
  settingsState?(ctx: RequestContext): Promise<Result<SettingsState>>;
  readSettingsReceipt?(ctx: RequestContext, approvalId: string): Promise<Result<SettingsReceipt | null>>;
  readDeletePlan?(ctx: RequestContext, id: string): Promise<Result<DeletePlan | null>>;
  readDeleteReport?(ctx: RequestContext, id: string): Promise<Result<DeleteReport | null>>;
  semanticQueryWithStatus?(ctx: RequestContext, query: string): Promise<Result<SemanticQueryResult>>;
  approveModel?(ctx: RequestContext, input: ModelApprovalRequest): Promise<Result<Approval>>;
  readModelOperation?(ctx: RequestContext, approvalId: string): Promise<Result<ModelOperationReceipt | null>>;
  closeModelOperation?(ctx: RequestContext, input: ModelCloseOperationRequest): Promise<Result<ModelOperationReceipt>>;
  readExtractionOperation?(ctx: RequestContext, approvalId: string): Promise<Result<ExtractionOperation | null>>;
  discoverExtractionOperations?(ctx: RequestContext, conversationId: string): Promise<Result<ExtractionDiscovery>>;
  saveGovernanceOperation?(ctx: RequestContext, input: GovernanceOperationSaveRequest): Promise<Result<GovernanceOperationState>>;
  readGovernanceOperation?(ctx: RequestContext, operationId: string): Promise<Result<GovernanceOperationState | null>>;
  readGovernanceOperationReceipt?(ctx: RequestContext, operationId: string): Promise<Result<GovernanceOperationReceipt | null>>;
  readReviewQuestions?(ctx: RequestContext, query: ReviewQuestionQuery): Promise<Result<ReviewQuestionPublic[]>>;
  startReviewAttempt?(ctx: RequestContext, input: ReviewAttemptStartRequest): Promise<Result<ReviewOperationReceipt>>;
  applyReviewEvent?(ctx: RequestContext, input: ReviewAttemptEventRequest): Promise<Result<ReviewOperationReceipt>>;
  saveReviewFeedback?(ctx: RequestContext, input: ReviewFeedbackRequest): Promise<Result<ReviewOperationReceipt>>;
  saveReviewAppeal?(ctx: RequestContext, input: ReviewAppealRequest): Promise<Result<ReviewOperationReceipt>>;
  readReviewAttempt?(ctx: RequestContext, attemptId: string): Promise<Result<ReviewAttemptPublic | null>>;
  readReviewOperation?(ctx: RequestContext, operationId: string): Promise<Result<ReviewOperationRecovery>>;
  readCandidateState?(ctx: RequestContext, conversationId: string): Promise<Result<CandidateState>>;
  readDraftState?(ctx: RequestContext, id: string): Promise<Result<DraftState>>;
  readDraftReceipt?(ctx: RequestContext, operationId: string): Promise<Result<DraftReceipt | null>>;
  saveReviewProgress?(ctx: RequestContext, progress: ReviewProgress, options: DraftSaveOptions): Promise<Result<DraftState>>;
  revokeApproval?(ctx: RequestContext, id: string): Promise<Result<{ revoked: boolean }>>;
  context(request: Request): Promise<Result<RequestContext>>;
  workspace(ctx: RequestContext): Promise<Result<Workspace>>;
  readIssue(ctx: RequestContext, issueNumber: number): Promise<Result<Conversation>>;
  saveConversation(ctx: RequestContext, input: Conversation, approval: Approval): Promise<Result<Conversation>>;
  readConversation(ctx: RequestContext, id: string): Promise<Result<Conversation>>;
  readCandidates(ctx: RequestContext, conversationId: string): Promise<Result<Candidate[]>>;
  saveCandidates(ctx: RequestContext, conversationId: string, candidates: Candidate[], options?: CandidateSaveOptions): Promise<Result<Candidate[]>>;
  readDraft(ctx: RequestContext, id: string): Promise<Result<HandoffDraft>>;
  saveDraft(ctx: RequestContext, draft: HandoffDraft, options?: DraftSaveOptions): Promise<Result<HandoffDraft>>;
  snapshot(ctx: RequestContext, revision?: string): Promise<Result<KnowledgeSnapshot>>;
  commit(ctx: RequestContext, changes: ChangeSet, approval: Approval): Promise<Result<CommitReceipt>>;
  semanticQuery(ctx: RequestContext, query: string): Promise<Result<{ objectId: string; score: number; text: string }[]>>;
  complete(ctx: RequestContext, input: { purpose: 'extract' | 'answer' | 'review'; text: string; sourceIds: string[]; approval: Approval }): Promise<Result<{ value: unknown; modelId: string; generatedAt: string }>>;
  appendEvidence(ctx: RequestContext, record: EvidenceRecord, approval: Approval): Promise<Result<EvidenceRecord>>;
  listEvidence(ctx: RequestContext, taskId?: string): Promise<Result<EvidenceRecord[]>>;
  previewDelete(ctx: RequestContext, objectIds: string[]): Promise<Result<DeletePlan>>;
  executeDelete(ctx: RequestContext, plan: DeletePlan, approval: Approval): Promise<Result<DeleteReport>>;
  exportData(ctx: RequestContext, objectIds: string[], approval: Approval): Promise<Result<{ files: { path: string; content: string }[]; limitations: string[] }>>;
  settings(ctx: RequestContext): Promise<Result<Settings>>;
  saveSettings(ctx: RequestContext, settings: Settings, approval: Approval): Promise<Result<Settings>>;
  audit(ctx: RequestContext): Promise<Result<AuditEvent[]>>;
}

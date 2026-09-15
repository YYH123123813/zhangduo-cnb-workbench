import type { Services } from '../contracts/ports';
import { unavailable } from '../contracts/api';
import type { SessionRegistry } from './identity';
import type { CnbClient } from './cnb/client';
import { IssueReader } from './cnb/issues';
import type { OperationJournal } from './journal';
import type { ApprovalAuthority } from './approvals';
import { ConversationWriter } from './cnb/conversation-writer';
import { SnapshotReader } from './cnb/snapshot';
import type { GitPublisher } from './cnb/git-publisher';
import { CommitWriter } from './cnb/commit-writer';
import { applyDeletionBarrier, GovernanceStore } from './governance';
import { KnowledgeQuery } from './cnb/knowledge';
import { IndexUpdateStore } from './cnb/indexing';
import { BoundedModel, missingModelSettings, type ModelTransport } from './model';
import { CnbModelTransport } from './cnb/model';
import { CandidateStore } from './candidates';
import { DraftStore } from './drafts';
import { EvidenceStore } from './evidence';
import { TaskStore } from './tasks';
import { HandoffOperationStore } from './handoff-operations';
import { ExtractionOperationStore } from './extractions';
import { GovernanceOperationStore } from './governance-operations';
import { ReviewQuestionStore, ReviewSessionStore } from './review-sessions';
import { DemoExportStore } from './demo-exports';
import { OperationRecoveryStore } from './operation-recovery';
import { RecoveryAnchorStore } from './recovery-anchors';
import type { ReviewAnswerExposure, ReviewQuestion } from '../contracts/review-session';
import { AIProviders, type ChatGateway } from './ai-providers';
import { PythonTraining, type TrainingExecutor } from './training-runner';
import { IntelligenceStore } from './intelligence';

export interface ServiceOptions {
  aiGateway?: ChatGateway; aiEnvironment?: () => NodeJS.ProcessEnv; trainingExecutor?: TrainingExecutor;
  sessions?: SessionRegistry; cnb?: CnbClient; journal?: OperationJournal; approvalAuthority?: ApprovalAuthority; git?: GitPublisher; model?: ModelTransport;
  reviewQuestions?: readonly ReviewQuestion[];
  reviewExposure?: { initial(input: { actorId: string; workspaceId: string; taskId: string; nodeRef: { workspaceId: string; objectId: string; revision: string } }): Promise<ReviewAnswerExposure> };
}

// Unconfigured is deliberately not a successful fixture or a pretend CNB adapter.
export function createServices(options: ServiceOptions = {}): Services {
  let services: Services;
  const intelligence = options.sessions && options.journal ? new IntelligenceStore(options.sessions, options.journal,
    options.aiGateway ?? new AIProviders(options.cnb, options.aiEnvironment ?? (() => ({}))),
    options.trainingExecutor ?? new PythonTraining(options.aiEnvironment?.().ZHANGDUO_TRAIN_BASE ?? ''), () => services) : undefined;
  const issues = options.sessions && options.cnb ? new IssueReader(options.sessions, options.cnb) : undefined;
  const snapshots = options.sessions && options.cnb ? new SnapshotReader(options.sessions, options.cnb) : undefined;
  const writer = options.sessions && options.cnb && options.journal && options.approvalAuthority
    ? new ConversationWriter(options.sessions, options.cnb, options.journal, options.approvalAuthority) : undefined;
  const commits = options.sessions && options.cnb && options.journal && options.approvalAuthority && options.git
    ? new CommitWriter(options.sessions, options.cnb, options.journal, options.approvalAuthority, options.git) : undefined;
  const readSnapshot: Services['snapshot'] = async (ctx, revision) => {
    if (ctx.mode === 'live' && (!options.journal || options.journal.fixture)) return unavailable('Durable deletion policy is required before live knowledge reads');
    const snapshot = await snapshots?.read(ctx, revision) ?? unavailable();
    return snapshot.ok ? { ok: true, data: options.journal ? applyDeletionBarrier(options.journal, ctx, snapshot.data) : snapshot.data } : snapshot;
  };
  const knowledge = options.sessions && options.cnb ? new KnowledgeQuery(options.sessions, options.cnb, readSnapshot) : undefined;
  const indexing = options.sessions && options.cnb && options.journal && options.approvalAuthority
    ? new IndexUpdateStore(options.sessions, options.journal, options.approvalAuthority, options.cnb, readSnapshot) : undefined;
  const evidence = options.sessions && options.journal && options.approvalAuthority
    ? new EvidenceStore(options.sessions, options.journal, options.approvalAuthority, readSnapshot) : undefined;
  const governance = options.sessions && options.journal && options.approvalAuthority
    ? new GovernanceStore(options.sessions, options.journal, options.approvalAuthority, async (ctx, revision) => snapshots?.read(ctx, revision) ?? unavailable(), evidence) : undefined;
  const readConversation: Services['readConversation'] = async (ctx, id) => (await writer?.readConversation(ctx, id)) ?? issues?.readConversation(ctx, id) ?? unavailable();
  const extractions = options.sessions && options.journal ? new ExtractionOperationStore(options.sessions, options.journal, readConversation) : undefined;
  const governanceOperations = options.sessions && options.journal ? new GovernanceOperationStore(options.sessions, options.journal) : undefined;
  const demoExports = options.sessions && options.journal && options.approvalAuthority && options.cnb
    ? new DemoExportStore(options.sessions, options.journal, options.approvalAuthority, async (ctx, revision) => snapshots?.read(ctx, revision) ?? unavailable()) : undefined;
  const operationRecovery = options.sessions && options.journal && options.approvalAuthority
    ? new OperationRecoveryStore(options.sessions, options.journal, options.approvalAuthority) : undefined;
  const recoveryAnchors = options.sessions && options.journal && operationRecovery
    ? new RecoveryAnchorStore(options.sessions, options.journal, async (ctx, input) => operationRecovery.read(ctx, input)) : undefined;
  const fallbackTransport = options.cnb ? new CnbModelTransport(options.cnb) : undefined;
  const modelTransport = options.model ?? (fallbackTransport && intelligence ? intelligence.modelTransport(fallbackTransport) : fallbackTransport);
  const model = options.sessions && options.journal && options.approvalAuthority && modelTransport
    ? new BoundedModel(options.sessions, options.journal, options.approvalAuthority, modelTransport, (ctx) => governance?.settingsState(ctx) ?? missingModelSettings(), readSnapshot, readConversation) : undefined;
  const candidates = options.sessions && options.journal && options.approvalAuthority
    ? new CandidateStore(options.sessions, options.journal, options.approvalAuthority, readConversation, (ctx) => governance?.settingsState(ctx) ?? missingModelSettings()) : undefined;
  const drafts = options.sessions && options.journal
    ? new DraftStore(options.sessions, options.journal, readConversation, async (ctx, id) => candidates?.read(ctx, id) ?? unavailable(), readSnapshot) : undefined;
  const tasks = options.sessions && options.journal ? new TaskStore(options.sessions, options.journal, readSnapshot) : undefined;
  const reviewQuestions = options.sessions && options.journal ? new ReviewQuestionStore(options.sessions, options.journal, options.reviewQuestions) : undefined;
  const reviews = options.sessions && options.journal && reviewQuestions && tasks
    ? new ReviewSessionStore(options.sessions, options.journal, reviewQuestions, readSnapshot, (ctx, id) => tasks.state(ctx, id), options.reviewExposure) : undefined;
  const handoffOperations = options.sessions && options.journal && drafts
    ? new HandoffOperationStore(options.sessions, options.journal, (ctx, id) => drafts.state(ctx, id), readConversation, readSnapshot) : undefined;
  services = {
    intelligenceCommand: async (ctx, input) => intelligence?.command(ctx, input) ?? unavailable(),
    previewIndexUpdate: async (ctx, input) => indexing?.preview(ctx, input) ?? unavailable(),
    approveIndexUpdate: async (ctx, input) => indexing?.approve(ctx, input) ?? unavailable(),
    executeIndexUpdate: async (ctx, input) => indexing?.execute(ctx, input) ?? unavailable(),
    readIndexOperation: async (ctx, id) => indexing?.read(ctx, id) ?? unavailable(),
    listIndexOperations: async (ctx) => indexing?.list(ctx) ?? unavailable(),
    readIndexStatus: async (ctx) => indexing?.status(ctx) ?? unavailable(),
    saveRecoveryAnchor: async (ctx, input) => recoveryAnchors?.save(ctx, input) ?? unavailable(),
    listRecoveryAnchors: async (ctx) => recoveryAnchors?.list(ctx) ?? unavailable(),
    readRecoveryAnchor: async (ctx, id) => recoveryAnchors?.read(ctx, id) ?? unavailable(),
    readReviewRuntime: async (ctx) => reviewQuestions?.runtime(ctx) ?? unavailable(),
    recordReviewExposure: async (ctx, refs) => reviews?.recordKnowledgeExposure(ctx, refs) ?? unavailable(),
    saveHandoffOperation: async (ctx, input) => handoffOperations?.save(ctx, input) ?? unavailable(),
    readHandoffOperation: async (ctx, id) => handoffOperations?.read(ctx, id) ?? unavailable(),
    readHandoffOperationReceipt: async (ctx, id) => handoffOperations?.receipt(ctx, id) ?? unavailable(),
    saveTask: async (ctx, input) => tasks?.save(ctx, input) ?? unavailable(),
    readTaskState: async (ctx, id) => tasks?.state(ctx, id) ?? unavailable(),
    readTaskReceipt: async (ctx, id) => tasks?.receipt(ctx, id) ?? unavailable(),
    approveEvidence: async (ctx, input) => evidence?.approve(ctx, input) ?? unavailable(),
    readEvidence: async (ctx, id) => evidence?.read(ctx, id) ?? unavailable(),
    readEvidenceReceipt: async (ctx, id) => evidence?.receipt(ctx, id) ?? unavailable(),
    readApprovalRegistration: async (ctx, query) => options.approvalAuthority?.readRegistration(ctx, query) ?? unavailable(),
    approveConversation: async (ctx, input) => options.approvalAuthority?.approveConversation(ctx, input) ?? unavailable(),
    approveKnowledge: async (ctx, input) => options.approvalAuthority?.approveKnowledge(ctx, input) ?? unavailable(),
    readKnowledgeApproval: async (ctx, id) => options.approvalAuthority?.readKnowledge(ctx, id) ?? unavailable(),
    readCommit: async (ctx, id) => commits?.read(ctx, id) ?? unavailable(),
    approveGovernance: async (ctx, input) => governance?.approve(ctx, input) ?? unavailable(),
    approveDemoExport: async (ctx, input) => demoExports?.approve(ctx, input) ?? unavailable(),
    executeDemoExport: async (ctx, input) => demoExports?.execute(ctx, input) ?? unavailable(),
    readDemoExport: async (ctx, id) => demoExports?.read(ctx, id) ?? unavailable(),
    readOperationRecovery: async (ctx, input) => operationRecovery?.read(ctx, input) ?? unavailable(),
    settingsState: async (ctx) => governance?.settingsState(ctx) ?? unavailable(),
    readSettingsReceipt: async (ctx, id) => governance?.readSettingsReceipt(ctx, id) ?? unavailable(),
    readDeletePlan: async (ctx, id) => governance?.readDeletePlan(ctx, id) ?? unavailable(),
    readDeleteReport: async (ctx, id) => governance?.readDeleteReport(ctx, id) ?? unavailable(),
    semanticQueryWithStatus: async (ctx, query) => knowledge?.query(ctx, query) ?? unavailable(),
    approveModel: async (ctx, input) => model?.approve(ctx, input) ?? unavailable(),
    readModelOperation: async (ctx, id) => model?.read(ctx, id) ?? unavailable(),
    closeModelOperation: async (ctx, input) => model?.close(ctx, input) ?? unavailable(),
    readExtractionOperation: async (ctx, id) => extractions?.read(ctx, id) ?? unavailable(),
    discoverExtractionOperations: async (ctx, id) => extractions?.discover(ctx, id) ?? unavailable(),
    saveGovernanceOperation: async (ctx, input) => governanceOperations?.save(ctx, input) ?? unavailable(),
    readGovernanceOperation: async (ctx, id) => governanceOperations?.read(ctx, id) ?? unavailable(),
    readGovernanceOperationReceipt: async (ctx, id) => governanceOperations?.readReceipt(ctx, id) ?? unavailable(),
    readReviewQuestions: async (ctx, query) => reviews?.listQuestions(ctx, query) ?? unavailable(),
    startReviewAttempt: async (ctx, input) => reviews?.start(ctx, input) ?? unavailable(),
    applyReviewEvent: async (ctx, input) => reviews?.event(ctx, input) ?? unavailable(),
    saveReviewFeedback: async (ctx, input) => reviews?.feedback(ctx, input) ?? unavailable(),
    saveReviewAppeal: async (ctx, input) => reviews?.appeal(ctx, input) ?? unavailable(),
    readReviewAttempt: async (ctx, id) => reviews?.read(ctx, id) ?? unavailable(),
    readReviewOperation: async (ctx, id) => reviews?.readOperation(ctx, id) ?? unavailable(),
    readCandidateState: async (ctx, id) => candidates?.state(ctx, id) ?? unavailable(),
    readDraftState: async (ctx, id) => drafts?.state(ctx, id) ?? unavailable(),
    readDraftReceipt: async (ctx, id) => drafts?.receipt(ctx, id) ?? unavailable(),
    saveReviewProgress: async (ctx, progress, options) => drafts?.saveProgress(ctx, progress, options) ?? unavailable(),
    revokeApproval: async (ctx, id) => options.approvalAuthority?.revoke(ctx, id) ?? unavailable(),
    context: async (request) => options.sessions?.context(request) ?? unavailable(),
    workspace: async (ctx) => options.sessions?.authorize(ctx, 'workspace:read') ?? unavailable(),
    readIssue: async (ctx, number) => issues?.readIssue(ctx, number) ?? unavailable(),
    saveConversation: async (ctx, input, approval) => writer?.save(ctx, input, approval) ?? unavailable(),
    readConversation, readCandidates: async (ctx, id) => candidates?.read(ctx, id) ?? unavailable(),
    saveCandidates: async (ctx, id, input, options) => candidates?.save(ctx, id, input, options) ?? unavailable(),
    readDraft: async (ctx, id) => drafts?.read(ctx, id) ?? unavailable(),
    saveDraft: async (ctx, draft, options) => drafts?.saveDraft(ctx, draft, options) ?? unavailable(), snapshot: readSnapshot,
    commit: async (ctx, changes, approval) => commits?.commit(ctx, changes, approval) ?? unavailable(),
    semanticQuery: async (ctx, query) => { const result = await knowledge?.query(ctx, query) ?? unavailable(); return result.ok ? { ok: true, data: result.data.hits } : result; },
    complete: async (ctx, input) => model?.complete(ctx, input) ?? unavailable(), appendEvidence: async (ctx, record, approval) => evidence?.append(ctx, record, approval) ?? unavailable(),
    listEvidence: async (ctx, taskId) => evidence?.list(ctx, taskId) ?? unavailable(), previewDelete: async (ctx, ids) => governance?.previewDelete(ctx, ids) ?? unavailable(),
    executeDelete: async (ctx, plan, approval) => governance?.executeDelete(ctx, plan, approval) ?? unavailable(),
    exportData: async (ctx, ids, approval) => governance?.exportData(ctx, ids, approval) ?? unavailable(),
    settings: async (ctx) => { const result = governance?.settingsState(ctx) ?? unavailable(); return result.ok ? { ok: true, data: result.data.settings } : result; },
    saveSettings: async (ctx, settings, approval) => governance?.saveSettings(ctx, settings, approval) ?? unavailable(),
    audit: async (ctx) => governance?.audit(ctx) ?? unavailable(),
  };
  return services;
}

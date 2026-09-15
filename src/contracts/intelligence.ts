import { z } from 'zod';
import { Id, Timestamp } from './domain';

export const MemoryWeightsSchema = z.object({
  defaultImportance: z.number().min(0).max(5), reuseInfluence: z.number().min(0).max(2),
  correctionBoost: z.number().min(1).max(3), maxWeight: z.number().min(1).max(10),
}).strict();
export const IntelligenceSettingsSchema = z.object({
  provider: z.enum(['cnb', 'openai', 'local']), weights: MemoryWeightsSchema,
  importance: z.record(z.string().min(1).max(160), z.number().min(0).max(5)),
  learningRate: z.number().min(0.000001).max(0.005), steps: z.number().int().min(5).max(200),
}).strict().refine((s) => Object.keys(s.importance).length <= 1000, 'Too many overrides');
export type IntelligenceSettings = z.infer<typeof IntelligenceSettingsSchema>;
export const DEFAULT_INTELLIGENCE: IntelligenceSettings = {
  provider: 'cnb', weights: { defaultImportance: 1, reuseInfluence: 0.25, correctionBoost: 1.5, maxWeight: 6 },
  importance: {}, learningRate: 0.0005, steps: 30,
};
export function trainingWeight(settings: IntelligenceSettings, node: { id: string; corrected: boolean; uses: number }): number {
  const importance = settings.importance[node.id] ?? settings.weights.defaultImportance;
  return Math.round(Math.min(settings.weights.maxWeight, importance * (1 + settings.weights.reuseInfluence * Math.log1p(Math.max(0, node.uses)))
    * (node.corrected ? settings.weights.correctionBoost : 1)) * 1000) / 1000;
}
export const ChatSchema = z.object({ id: Id, title: z.string(), revision: z.number().int().positive(),
  messages: z.array(z.object({ id: Id, role: z.enum(['user', 'assistant']), text: z.string().max(24000), createdAt: Timestamp }).strict()).max(100),
  status: z.enum(['ready', 'sending', 'unknown']), provider: z.enum(['cnb', 'openai', 'local']),
  createdAt: Timestamp, expiresAt: Timestamp, archivedConversationId: Id.optional(),
}).strict();
export type MemoryChat = z.infer<typeof ChatSchema>;
export const TrainingRunSchema = z.object({ id: Id, state: z.enum(['running', 'completed', 'failed', 'interrupted', 'deleted']),
  cleanupReady: z.boolean().optional(),
  mode: z.enum(['smoke', 'lora']), createdAt: Timestamp, completedAt: Timestamp.optional(),
  datasetHash: z.string(), settingsRevision: z.number().int(), sampleCount: z.number().int(),
  nodeRefs: z.array(z.object({ id: Id, revision: Id }).strict()),
  metrics: z.object({ beforeLoss: z.number().nonnegative(), afterLoss: z.number().nonnegative(), heldOutBefore: z.number().nonnegative().nullable(), heldOutAfter: z.number().nonnegative().nullable(),
    parameterDelta: z.number().nonnegative(), trainableParameters: z.number().int().positive(), totalParameters: z.number().int().positive(), steps: z.number().int().min(1).max(200),
    weightEffect: z.number().nonnegative(), reloadVerified: z.boolean(), validationGroups: z.number().int().nonnegative(),
  }).strict().refine((metrics) => metrics.trainableParameters <= metrics.totalParameters, 'Invalid trainable parameter count').optional(), message: z.string(),
}).strict();
export type TrainingRun = z.infer<typeof TrainingRunSchema>;
export const IntelligenceOverviewSchema = z.object({
  revision: z.number().int().nonnegative(), settings: IntelligenceSettingsSchema,
  providers: z.array(z.object({ id: z.enum(['cnb', 'openai', 'local']), ready: z.boolean(), model: z.string() }).strict()),
  training: z.object({ ready: z.boolean(), pretrainedReady: z.boolean(), activeRunId: z.string().nullable() }).strict(),
  samples: z.array(z.object({ id: Id, revision: Id, title: z.string(), weight: z.number(), uses: z.number().int(), corrected: z.boolean() }).strict()),
  samplesStatus: z.object({ state: z.enum(['ready', 'unavailable']), message: z.string() }).strict().optional(),
  runs: z.array(TrainingRunSchema), chats: z.array(ChatSchema.omit({ messages: true })),
}).strict();
export type IntelligenceOverview = z.infer<typeof IntelligenceOverviewSchema>;
export const IntelligenceMutationSchema = z.enum(['settings', 'create_chat', 'send', 'archive', 'delete_chat', 'train', 'activate', 'deactivate', 'delete_run']);
export const IntelligenceOperationSchema = z.object({
  operationId: z.string().uuid(), action: IntelligenceMutationSchema.nullable(), requestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  targetId: Id.nullable(), state: z.enum(['not_found', 'pending', 'completed', 'failed', 'unknown']),
  result: z.object({ revision: z.number().int().nonnegative().optional(), chatId: Id.optional(), conversationId: Id.optional(),
    issueNumber: z.number().int().positive().optional(), taskId: Id.optional(), runId: Id.optional(),
    activeRunId: Id.nullable().optional(), deleted: z.boolean().optional(), physicalErasure: z.literal(false).optional(),
    cnbArchiveDeleted: z.literal(false).optional(),
  }).strict().nullable(), updatedAt: Timestamp.nullable(), readOnly: z.literal(true), absenceIsFinal: z.literal(false),
}).strict();
export type IntelligenceOperation = z.infer<typeof IntelligenceOperationSchema>;
const Operation = { operationId: z.string().uuid(), confirmed: z.literal(true) };
export const IntelligenceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview') }).strict(),
  z.object({ action: z.literal('settings'), ...Operation, expectedRevision: z.number().int().nonnegative(), settings: IntelligenceSettingsSchema }).strict(),
  z.object({ action: z.literal('create_chat'), ...Operation, title: z.string().trim().min(1).max(120), retentionDays: z.literal(30) }).strict(),
  z.object({ action: z.literal('read_chat'), id: Id }).strict(),
  z.object({ action: z.literal('read_operation'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('send'), ...Operation, id: Id, expectedRevision: z.number().int().positive(), text: z.string().trim().min(1).max(12000), provider: z.enum(['cnb', 'openai', 'local']), modelConsent: z.literal(true) }).strict(),
  z.object({ action: z.literal('archive'), ...Operation, id: Id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('delete_chat'), ...Operation, id: Id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('train'), ...Operation, expectedRevision: z.number().int().nonnegative(), mode: z.enum(['smoke', 'lora']), nodeIds: z.array(Id).max(100), nodeRevisions: z.record(Id, Id).default({}), trainingConsent: z.literal(true) }).strict(),
  z.object({ action: z.literal('activate'), ...Operation, id: Id }).strict(),
  z.object({ action: z.literal('deactivate'), ...Operation }).strict(),
  z.object({ action: z.literal('delete_run'), ...Operation, id: z.string().uuid() }).strict(),
]);
export type IntelligenceCommand = z.infer<typeof IntelligenceCommandSchema>;
export type IntelligenceMutation = Extract<IntelligenceCommand, { operationId: string }>;
export interface TrainingSample { id: string; groupId: string; input: string; target: string; weight: number }

import { z } from 'zod';
import { ApprovalSchema, CandidateSchema, Id, Timestamp } from './domain';
import { canonicalJson } from './hash';

export const CandidateProjectionSchema = CandidateSchema.pick({ title: true, question: true, claim: true, kind: true, whyKeep: true, uncertainties: true }).extend({
  title: z.string().trim().min(1).max(120), question: z.string().trim().min(1).max(4000), claim: z.string().trim().min(1).max(8000),
  whyKeep: z.string().trim().min(1).max(2000), uncertainties: z.array(z.string().max(2000)).max(12),
  spans: z.array(z.object({ segmentId: Id, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(24000) }).strict()).min(1).max(12),
}).strict();
export const CandidateOutputSchema = z.object({ candidates: z.array(CandidateProjectionSchema).max(3) }).strict();
export function normalizedCandidateProjections(input: unknown) {
  const projections = z.array(CandidateProjectionSchema).max(3).parse(input).map((item) => ({ ...item, spans: [...new Map(item.spans.map((span) => [canonicalJson(span), span])).values()] }));
  return [...new Map(projections.map((item) => [canonicalJson(item), item])).values()];
}
export const CandidateSaveOptionsSchema = z.object({ modelApproval: ApprovalSchema, expectedConversationHash: Id, expectedRevision: z.number().int().nonnegative(), retentionDays: z.literal(7), confirmed: z.literal(true) }).strict();
export type CandidateSaveOptions = z.infer<typeof CandidateSaveOptionsSchema>;
export const CandidateStateSchema = z.object({ conversationId: Id, conversationHash: Id, revision: z.number().int().nonnegative(), state: z.enum(['missing', 'available', 'expired']), candidates: z.array(CandidateSchema).max(3), modelApprovalId: Id.optional(), expiresAt: Timestamp.optional(), retentionDays: z.literal(7) }).strict();
export type CandidateState = z.infer<typeof CandidateStateSchema>;

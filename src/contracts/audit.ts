import { z } from 'zod';
import { Id, Timestamp } from './domain';

export const AuditOperationSchema = z.object({ kind: z.enum(['knowledge', 'settings', 'delete', 'evidence']), id: Id }).strict();
export type AuditOperation = z.infer<typeof AuditOperationSchema>;
export const AuditEventSchema = z.object({ action: Id, objectIds: z.array(Id), occurredAt: Timestamp,
  outcome: Id, operation: AuditOperationSchema.optional() }).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

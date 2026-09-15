import { z } from 'zod';
import { Mode } from './domain';

// Public fixture-only connection key, never a live credential.
export const LOCAL_DEMO_KEY = 'f'.repeat(64);

export const ConnectionRequestSchema = z.object({ connectionKey: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict();
export const RuntimeStatusSchema = z.object({ state: z.enum(['unconfigured', 'ready', 'connected', 'unreachable', 'revoked']), mode: Mode,
  cnbConnected: z.boolean(), storage: z.enum(['not_configured', 'persistent']), missing: z.array(z.string().regex(/^[A-Z0-9_]+$/)).max(30),
}).strict();
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

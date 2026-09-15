import { z } from 'zod';
import type { Result } from '../../contracts/api';
import { failure } from '../result';

export const RepositorySlug = z.string().max(140).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/)
  .refine((value) => !value.endsWith('.git') && !value.split('/').some((part) => part === '.' || part === '..'));
export const CNB_API_ORIGIN = 'https://api.cnb.cool';
export type Transport = typeof fetch;

const ProbeInput = z.object({
  repository: RepositorySlug,
  token: z.string().min(1).max(4096).regex(/^\S+$/),
  authorizedRepository: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  gitRef: z.string().min(1).max(200).optional(),
  knowledge: z.boolean().optional(),
}).strict();

export interface CapabilityReport {
  checkedAt: string;
  evidence: 'http_read_observation_only';
  reads: { capability: string; state: 'observed' | 'denied' | 'unavailable'; httpStatus?: number }[];
  pending: string[];
}

// This opt-in verifier never writes, queries an embedding model, or invokes AI.
export async function verifyCapabilities(input: unknown, transport: Transport = fetch, signal?: AbortSignal): Promise<Result<CapabilityReport>> {
  const parsed = ProbeInput.safeParse(input);
  if (!parsed.success) return failure('VALIDATION', 'Invalid CNB verification configuration', 'check_verification_config');
  const config = parsed.data;
  if (config.authorizedRepository !== config.repository) return failure('FORBIDDEN', 'Repository read verification is not authorized', 'authorize_exact_repository');
  if (signal?.aborted) return failure('FORBIDDEN', 'Verification cancelled', 'none');
  const prefix = `/${config.repository.split('/').map(encodeURIComponent).join('/')}`;
  const paths: [string, string][] = [['identity', '/user'], ['repository', prefix]];
  if (config.issueNumber) paths.push(['issue', `${prefix}/-/issues/${config.issueNumber}`]);
  if (config.gitRef) paths.push(['git_snapshot', `${prefix}/-/git/commits/${encodeURIComponent(config.gitRef)}`]);
  if (config.knowledge) paths.push(['knowledge_configuration', `${prefix}/-/knowledge/base`]);
  const report: CapabilityReport = {
    checkedAt: new Date().toISOString(), evidence: 'http_read_observation_only', reads: [],
    pending: ['issue_visibility_between_actors', 'git_atomic_write_and_readback', 'ai_model_and_cost', 'knowledge_filter_isolation', 'judge_read_only_access', 'physical_deletion_limits'],
  };
  for (const [capability, path] of paths) {
    if (signal?.aborted) break;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await transport(new URL(path, CNB_API_ORIGIN), {
        method: 'GET', headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      report.reads.push({ capability, state: response.ok ? 'observed' : [401, 403, 404].includes(response.status) ? 'denied' : 'unavailable', httpStatus: response.status });
      await response.body?.cancel();
      if (!response.ok) break;
    } catch {
      report.reads.push({ capability, state: 'unavailable' });
      break;
    }
  }
  return { ok: true, data: report };
}

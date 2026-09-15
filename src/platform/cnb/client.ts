import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Result } from '../../contracts/api';
import { failure } from '../result';
import { CNB_API_ORIGIN, RepositorySlug, type Transport } from './capabilities';

export interface ServerConfig { repository: string; token: string; tokenScopes: string[]; modelId?: string; writesAuthorized: boolean; aiAuthorized: boolean; queriesAuthorized?: boolean; aiPipelineAuthorized?: boolean; aiOutputLimitVerified?: boolean; indexAuthorized?: boolean; embeddingModel?: string }
const ConfigSchema = z.object({
  repository: RepositorySlug, token: z.string().min(1).max(4096).regex(/^\S+$/),
  tokenScopes: z.array(z.string().regex(/^[a-z-]+:(r|rw)$/)).min(1),
  modelId: z.string().min(1).optional(), writesAuthorized: z.boolean(), aiAuthorized: z.boolean(), queriesAuthorized: z.boolean(),
  aiPipelineAuthorized: z.boolean(), aiOutputLimitVerified: z.boolean(),
  indexAuthorized: z.boolean(), embeddingModel: z.string().regex(/^[A-Za-z0-9._-]{1,160}$/).optional(),
});

export function readServerConfig(env: Record<string, string | undefined> = process.env): Result<ServerConfig> {
  if (Object.entries(env).some(([key, value]) => value && /^VITE_.*(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key))) return failure('VALIDATION', 'Client-exposed secret configuration is forbidden', 'remove_client_secret');
  if (!env.CNB_REPO_SLUG || !env.CNB_TOKEN) return failure('NOT_CONFIGURED', 'Server CNB credentials are not configured', 'configure_server_workspace');
  if (env.CNB_LIVE_READS_FOR !== env.CNB_REPO_SLUG) return failure('FORBIDDEN', 'Live repository access is not authorized', 'authorize_exact_repository');
  const parsed = ConfigSchema.safeParse({
    repository: env.CNB_REPO_SLUG, token: env.CNB_TOKEN,
    tokenScopes: env.CNB_TOKEN_SCOPES?.split(',').map((scope) => scope.trim()).filter(Boolean) ?? [],
    modelId: env.CNB_AI_MODEL || undefined,
    writesAuthorized: env.CNB_LIVE_WRITES_FOR === env.CNB_REPO_SLUG,
    aiAuthorized: env.CNB_LIVE_AI_FOR === env.CNB_REPO_SLUG,
    queriesAuthorized: env.CNB_LIVE_QUERIES_FOR === env.CNB_REPO_SLUG,
    aiPipelineAuthorized: Boolean(env.CNB_BUILD_ID) && env.CNB_LIVE_AI_PIPELINE_FOR === env.CNB_REPO_SLUG,
    aiOutputLimitVerified: env.CNB_AI_OUTPUT_LIMIT_VERIFIED === 'true',
    indexAuthorized: env.CNB_LIVE_INDEX_FOR === env.CNB_REPO_SLUG,
    embeddingModel: env.CNB_INDEX_EMBEDDING_MODEL || undefined,
  });
  return parsed.success ? { ok: true, data: parsed.data } : failure('VALIDATION', 'Invalid server CNB configuration', 'check_server_configuration');
}

async function boundedJson(response: Response): Promise<unknown> {
  const maximum = 2_000_000;
  if (Number(response.headers.get('Content-Length')) > maximum) { await response.body?.cancel(); throw new Error('Response too large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class CnbClient {
  readonly mode: 'fixture' | 'live';
  private readonly transport: Transport;
  private binding?: string;

  constructor(private readonly configuration: () => Result<ServerConfig> = readServerConfig, transport?: Transport) {
    this.mode = transport ? 'fixture' : 'live';
    this.transport = transport ?? fetch;
  }

  config(): Result<ServerConfig> {
    const result = this.configuration();
    if (!result.ok) return result;
    const binding = createHash('sha256').update(JSON.stringify(result.data)).digest('hex');
    if (this.binding && this.binding !== binding) return failure('FORBIDDEN', 'CNB credential or permission binding changed', 'reestablish_trusted_connection');
    this.binding = binding;
    return result;
  }

  async read(scope: string, path: string, account = false, signal?: AbortSignal): Promise<Result<unknown>> {
    return this.request('GET', scope, path, account, signal);
  }

  async createIssue(input: { title: string; body: string; invisible: true }): Promise<Result<unknown>> {
    const parsed = z.object({ title: z.string().min(2).max(255), body: z.string().max(1_000_000), invisible: z.literal(true) }).strict().safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Invalid private Issue payload', 'preview_again');
    return this.request('POST', 'repo-issue:rw', '/-/issues', false, undefined, parsed.data);
  }

  async startIndexBuild(input: { sha: string; config: string; title: string }): Promise<Result<unknown>> {
    const parsed = z.object({ sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), config: z.string().max(150_000),
      title: z.string().regex(/^zhangduo-index [a-f0-9]{64}$/) }).strict().safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Invalid controlled index build', 'preview_index_update');
    return this.request('POST', 'repo-cnb-trigger:rw', '/-/build/start', false, undefined, { ...parsed.data, event: 'api_trigger_zhangduo_index', sync: 'false' });
  }

  modelReady(): Result<true> {
    const config = this.config(); if (!config.ok) return config;
    if (!config.data.aiAuthorized || !config.data.modelId) return failure('NOT_CONFIGURED', 'A separately authorized model must be configured', 'configure_model_budget');
    if (this.mode === 'live' && (!config.data.aiPipelineAuthorized || !config.data.aiOutputLimitVerified)) return failure('NOT_CONFIGURED', 'Live AI requires an authorized CNB pipeline and a verified model output limit', 'verify_pipeline_model_capabilities');
    return { ok: true, data: true };
  }

  async chat(input: { system: string; text: string; maxOutputTokens: number }): Promise<Result<unknown>> {
    const ready = this.modelReady(); if (!ready.ok) return ready;
    const config = this.config(); if (!config.ok) return config;
    const parsed = z.object({ system: z.string().min(1).max(4000), text: z.string().min(1).max(32000), maxOutputTokens: z.number().int().min(1).max(2048) }).strict().safeParse(input);
    if (!parsed.success) return failure('VALIDATION', 'Model request exceeds its input or output budget', 'reduce_model_scope');
    return this.request('POST', 'repo-code:r', '/-/ai/chat/completions', false, undefined, { model: config.data.modelId, stream: false,
      messages: [{ role: 'system', content: parsed.data.system }, { role: 'user', content: parsed.data.text }], max_tokens: parsed.data.maxOutputTokens });
  }

  private async request(method: 'GET' | 'POST', scope: string, path: string, account: boolean, signal?: AbortSignal, body?: unknown): Promise<Result<unknown>> {
    const config = this.config();
    if (!config.ok) return config;
    const model = path === '/-/ai/chat/completions', index = path === '/-/build/start';
    const readbackAction = model ? 'review_model_operation' : index ? 'read_index_operation' : 'read_back_same_conversation';
    if (method === 'POST' && !model && !index && !config.data.writesAuthorized) return failure('FORBIDDEN', 'Live Issue writing is not authorized', 'authorize_repository_writes');
    if (method === 'POST' && index && !config.data.indexAuthorized) return failure('FORBIDDEN', 'Index updates are not separately authorized', 'authorize_index_update');
    if (method === 'POST' && model && !config.data.aiAuthorized) return failure('FORBIDDEN', 'Model transmission is not authorized', 'authorize_model_input');
    if (signal?.aborted) return failure('FORBIDDEN', 'Request cancelled', 'none');
    if (!config.data.tokenScopes.includes(scope) && !config.data.tokenScopes.includes(scope.replace(/:r$/, ':rw'))) return failure('FORBIDDEN', 'Required CNB token scope is missing', 'configure_minimum_token_scope');
    if ((account ? path !== '/user' : !path.startsWith('/-/') && path !== '') || /\\|\.\.|%2e|%5c/i.test(path.split('?')[0] ?? '') || /#|\s/.test(path)) return failure('VALIDATION', 'Invalid CNB resource path', 'check_resource_path');
    const prefix = account ? '' : `/${config.data.repository.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(`${prefix}${path}`, CNB_API_ORIGIN);
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await this.transport(url, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${config.data.token}`, Accept: 'application/vnd.cnb.api+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) return failure('UNAUTHORIZED', 'CNB credentials are invalid or revoked', 'renew_server_credentials');
        if ([403, 404].includes(response.status)) return failure('FORBIDDEN', 'CNB resource is unavailable or inaccessible', 'check_resource_permissions');
        if (method === 'POST') return failure('UNKNOWN_RESULT', 'CNB operation result could not be verified', readbackAction, 'unknown');
        return failure('UPSTREAM', 'CNB read request failed', 'retry_read', 'not_written', true);
      }
      const data = await boundedJson(response);
      const stillConfigured = this.config();
      if (!stillConfigured.ok) return method === 'POST' ? failure('UNKNOWN_RESULT', 'CNB configuration changed during the operation', readbackAction, 'unknown') : stillConfigured;
      return { ok: true, data };
    } catch {
      if (method === 'POST') return failure('UNKNOWN_RESULT', 'CNB operation result could not be verified', readbackAction, 'unknown');
      return failure('UPSTREAM', 'CNB response could not be verified', 'retry_read', 'not_written', true);
    }
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Result } from '../contracts/api';
import { Id } from '../contracts/domain';
import type { Services } from '../contracts/ports';
import { ConnectionRequestSchema, type RuntimeStatus } from '../contracts/runtime';
import type { WorkspaceSession } from '../contracts/session';
import { createServices, type ServiceOptions } from './services';
import { SessionRegistry } from './identity';
import { OperationJournal } from './journal';
import { ApprovalAuthority } from './approvals';
import { CnbClient } from './cnb/client';
import { RestrictedGitPublisher, type GitRunner, type GitPublisher } from './cnb/git-publisher';
import { loadRuntimeEnvironment, readRuntimeConfig, type RuntimeConfiguration } from './runtime-config';
import { failure } from './result';
import { importReviewCatalog, readPrivateReviewCatalog } from './review-catalog';

export interface ServerRuntime {
  services: Services;
  status(): RuntimeStatus;
  connect(input: unknown, request: Request): Promise<Result<{ sessionToken: string; session: WorkspaceSession }>>;
  disconnect(request: Request): Result<{ disconnected: true }>;
  close(): void;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RemoteUser = z.object({ id: Id, username: z.string().regex(/^[A-Za-z0-9_.@-]{1,160}$/) });
const RemoteRepository = z.object({ id: Id, path: z.string(), visibility_level: z.literal('Private') });

export interface RuntimeFixtures extends Pick<ServiceOptions, 'aiGateway' | 'trainingExecutor'> {
  transport?: typeof fetch; gitRunner?: GitRunner; git?: GitPublisher;
}
export function createRuntime(environment: () => NodeJS.ProcessEnv = loadRuntimeEnvironment, fixture: RuntimeFixtures = {}): ServerRuntime {
  const configuration = (): RuntimeConfiguration => { try { return readRuntimeConfig(environment()); } catch { return { ok: false, missing: ['PRIVATE_ENV_FILE'] }; } };
  const configured = configuration();
  let status: RuntimeStatus = { state: 'unconfigured', mode: 'unconfigured', cnbConnected: false, storage: 'not_configured', missing: configured.ok ? [] : configured.missing };
  const unconfigured: ServerRuntime = { services: createServices(), status: () => ({ ...status, missing: [...status.missing] }),
    connect: async () => failure('NOT_CONFIGURED', 'The server workspace configuration is incomplete', 'configure_server_workspace'),
    disconnect: () => failure('NOT_CONFIGURED', 'No server workspace is configured', 'configure_server_workspace'), close: () => {} };
  if (!configured.ok) return unconfigured;
  const config = configured.data, mode = fixture.transport ? 'fixture' as const : 'live' as const;
  if (!config.stateFile.startsWith(`.local/${mode}/`) || ((fixture.gitRunner || fixture.git || fixture.aiGateway || fixture.trainingExecutor) && !fixture.transport)
    || (fixture.git && fixture.git.mode !== 'fixture')) { status.missing = ['ZHANGDUO_STORAGE_MODE']; return unconfigured; }
  let journal: OperationJournal;
  try { journal = new OperationJournal(config.stateFile, { fixture: mode === 'fixture' }); }
  catch { status.missing = ['ZHANGDUO_STATE_FILE']; return unconfigured; }
  const binding = digest(config);
  let invalidated = false, verificationUnavailable = false;
  try {
    journal.transaction(() => {
      const previous = journal.record('@server', '@server', 'runtime_configuration', 'binding');
      if (previous?.value !== binding) {
        journal.revokeAllApprovals();
        if (!journal.putRecord('@server', '@server', 'runtime_configuration', 'binding', binding, previous?.version ?? null)) throw new Error('Configuration binding conflict');
      }
    });
    journal.expirePrivatePayloads();
  } catch { journal.close(); status.missing = ['ZHANGDUO_STATE_FILE']; return unconfigured; }
  const guard = (): Result<true> => {
    const current = configuration();
    if (invalidated || !current.ok || digest(current.data) !== binding) {
      if (!invalidated) { invalidated = true; journal.revokeAllApprovals(); }
      verificationUnavailable = false;
      status = { ...status, state: 'revoked', cnbConnected: false };
      return failure('UNAUTHORIZED', 'Server credentials or permissions changed; reconnect after server restart', 'restart_and_reconnect');
    }
    return { ok: true, data: true };
  };
  const sessions = new SessionRegistry(Date.now, guard);
  const authority = new ApprovalAuthority(sessions, journal);
  const cnb = new CnbClient(() => { const valid = guard(); return valid.ok ? { ok: true, data: config.cnb } : valid; }, fixture.transport);
  let identity: { userId: string; repositoryId: string; username: string } | undefined;
  const git = fixture.git ?? new RestrictedGitPublisher(() => {
    const valid = guard(); if (!valid.ok) return valid;
    return identity ? { ok: true, data: { repository: config.cnb.repository, username: identity.username, token: config.cnb.token, writesAuthorized: config.cnb.writesAuthorized } }
      : failure('UNAUTHORIZED', 'A verified server connection is required for Git', 'connect_workspace');
  }, fixture.gitRunner);
  const services = createServices({ sessions, journal, approvalAuthority: authority, cnb, git, aiEnvironment: environment,
    aiGateway: fixture.aiGateway, trainingExecutor: fixture.trainingExecutor });
  status = { state: 'ready', mode, cnbConnected: false, storage: 'persistent', missing: [] };
  const verify = async (signal?: AbortSignal): Promise<Result<{ userId: string; repositoryId: string; username: string }>> => {
    const user = await cnb.read('account-profile:r', '/user', true, signal); if (!user.ok) return user;
    const repository = await cnb.read('repo-basic-info:r', '', false, signal); if (!repository.ok) return repository;
    const parsedUser = RemoteUser.safeParse(user.data), parsedRepo = RemoteRepository.safeParse(repository.data);
    if (!parsedUser.success || !parsedRepo.success || parsedRepo.data.path !== config.cnb.repository) return failure('FORBIDDEN', 'CNB identity or private repository could not be verified', 'verify_private_repository');
    const result = { userId: parsedUser.data.id, repositoryId: parsedRepo.data.id, username: parsedUser.data.username };
    if (identity && digest(result) !== digest(identity)) return failure('FORBIDDEN', 'CNB identity changed during this connection', 'restart_and_reconnect');
    if (signal?.aborted) return failure('FORBIDDEN', 'Connection verification was cancelled', 'connect_workspace');
    return { ok: true, data: result };
  };
  const originalContext = services.context;
  services.context = async (request) => {
    const context = await originalContext(request); if (!context.ok) return context;
    const valid = await verify(request.signal);
    if (request.signal.aborted) return failure('FORBIDDEN', 'Session verification was cancelled', 'retry_read');
    if (!valid.ok) {
      verificationUnavailable = true;
      status = { ...status, state: 'unreachable', cnbConnected: false };
      if (['UNAUTHORIZED', 'FORBIDDEN'].includes(valid.error.code)) sessions.revokeAll();
      return valid;
    }
    const final = sessions.authorize(context.data, 'workspace:read');
    if (!final.ok) return final;
    if (verificationUnavailable) {
      verificationUnavailable = false;
      status = { ...status, state: 'connected', cnbConnected: mode === 'live' };
    }
    return context;
  };
  let attempting = false, attempts: number[] = [], closed = false;
  const cleanup = setInterval(() => { try { journal.expirePrivatePayloads(); } catch { verificationUnavailable = false; status = { ...status, state: 'unreachable' }; } }, 60_000);
  cleanup.unref();
  return { services, status: () => { guard(); return { ...status, missing: [...status.missing] }; },
    connect: async (input, request) => {
      const parsed = ConnectionRequestSchema.safeParse(input);
      if (!parsed.success) return failure('VALIDATION', 'Connection requires the local key and explicit confirmation only', 'confirm_connection');
      const valid = guard(); if (!valid.ok) return valid;
      attempts = attempts.filter((time) => Date.now() - time < 60_000);
      if (attempting || attempts.length >= 5) return failure('FORBIDDEN', 'Connection attempts are temporarily limited', 'wait_before_connecting');
      attempts.push(Date.now());
      if (!timingSafeEqual(Buffer.from(parsed.data.connectionKey, 'hex'), Buffer.from(config.connectionKey, 'hex'))) return failure('UNAUTHORIZED', 'The local connection key was not accepted', 'check_connection_key');
      attempting = true;
      try {
        const remote = await verify(request.signal);
        if (!remote.ok) { verificationUnavailable = true; status = { ...status, state: 'unreachable', cnbConnected: false }; return remote; }
        const stillValid = guard(); if (!stillValid.ok) return stillValid;
        identity = remote.data;
        const workspace = { id: `cnb-repo:${identity.repositoryId}`, slug: config.cnb.repository, visibility: 'private' as const, mode };
        const actorId = `cnb-user:${identity.userId}`;
        const stored = journal.record('@server', '@server', 'runtime_binding', 'owner');
        const owner = { actorId, workspaceId: workspace.id, slug: workspace.slug };
        if (stored && digest(stored.value) !== digest(owner)) return failure('FORBIDDEN', 'Private storage is bound to another owner or repository', 'use_matching_private_storage');
        if (!stored && !journal.putRecord('@server', '@server', 'runtime_binding', 'owner', owner, null)) return failure('CONFLICT', 'Storage owner was bound concurrently', 'restart_and_reconnect');
        if (config.reviewCatalogFile) importReviewCatalog(sessions, journal, readPrivateReviewCatalog(config.reviewCatalogFile, mode), workspace.id);
        const sessionToken = sessions.issue({ actorId, workspace, scopes: config.scopes });
        verificationUnavailable = false;
        status = { ...status, state: 'connected', cnbConnected: mode === 'live' };
        return { ok: true, data: { sessionToken, session: { actorId, workspace, scopes: [...config.scopes] } } };
      } catch { return failure('INTERNAL', 'Connection state could not be verified', 'check_server_storage', 'unknown'); }
      finally { attempting = false; }
    },
    disconnect: (request) => {
      const context = sessions.context(request); if (!context.ok) return context;
      sessions.revokeAll(); verificationUnavailable = false; status = { ...status, state: 'ready', cnbConnected: false };
      return { ok: true, data: { disconnected: true } };
    },
    close: () => { if (!closed) { closed = true; clearInterval(cleanup); sessions.revokeAll(); journal.close(); } },
  };
}

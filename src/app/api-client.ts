import type { ApiResponse } from '../contracts/api';
import { CONTRACT_VERSION } from '../contracts/domain';
import { SESSION_BINDING_HEADER, workspaceSessionBinding, type WorkspaceSession } from '../contracts/session';

interface PageBinding { session: WorkspaceSession; hash: Promise<string>; lifetime: AbortController }
let activeBinding: PageBinding | null = null;

export function bindIntelligenceSession(value: WorkspaceSession): () => void {
  activeBinding?.lifetime.abort();
  const session = structuredClone(value);
  const binding = { session, hash: workspaceSessionBinding(session), lifetime: new AbortController() };
  activeBinding = binding;
  return () => { binding.lifetime.abort(); if (activeBinding === binding) activeBinding = null; };
}

function bindingDenied<T>(binding: PageBinding | null, dataState: 'not_written' | 'preserved' | 'unknown'): ApiResponse<T> {
  return { ok: false, error: { code: 'FORBIDDEN', message: '页面身份或服务端身份绑定尚未核验，请重新核对工作区；不会自动重发。',
    dataState, retryable: false, nextAction: 'verify_workspace_session' },
  meta: { requestId: crypto.randomUUID(), mode: binding?.session.workspace.mode ?? 'unconfigured', contractVersion: CONTRACT_VERSION } };
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const intelligence = /^\/api\/intelligence(?:[/?]|$)/.test(path);
  const binding = intelligence ? activeBinding : null;
  if (intelligence && !binding) return bindingDenied(null, 'not_written');
  const fingerprint = binding ? await binding.hash : null;
  if (binding && (activeBinding !== binding || binding.lifetime.signal.aborted)) return bindingDenied(binding, 'not_written');
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (fingerprint) headers.set(SESSION_BINDING_HEADER, fingerprint);
  const signal = binding ? AbortSignal.any([binding.lifetime.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal;
  const response = await fetch(path, { ...init, headers, signal });
  const unsettled = !['GET', 'HEAD', 'OPTIONS'].includes(init?.method?.toUpperCase() ?? 'GET') ? 'unknown' : 'preserved';
  if (binding && (activeBinding !== binding || binding.lifetime.signal.aborted || response.headers.get(SESSION_BINDING_HEADER) !== fingerprint)) {
    return bindingDenied(binding, unsettled);
  }
  const body: unknown = await response.json();
  if (binding && (activeBinding !== binding || binding.lifetime.signal.aborted)) return bindingDenied(binding, unsettled);
  if (!body || typeof body !== 'object' || !('ok' in body) || !('meta' in body)) {
    throw new Error('Invalid API envelope');
  }
  if (binding && (!body.meta || typeof body.meta !== 'object' || !('mode' in body.meta) || body.meta.mode !== binding.session.workspace.mode)) {
    return bindingDenied(binding, unsettled);
  }
  return body as ApiResponse<T>;
}

import { describe, expect, it, vi } from 'vitest';
import { CnbClient, readServerConfig } from './client';

const env = { CNB_REPO_SLUG: 'fixture/project', CNB_TOKEN: 'fixture-server-secret', CNB_LIVE_READS_FOR: 'fixture/project', CNB_TOKEN_SCOPES: 'account-profile:r,repo-basic-info:r,repo-issue:r' };

describe('W03 server-only credentials and least privilege', () => {
  it('fails closed without configuration or exact repository authorization', () => {
    expect(readServerConfig({})).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(readServerConfig({ ...env, CNB_REPO_SLUG: undefined })).toMatchObject({ ok: false });
    expect(readServerConfig({ ...env, CNB_LIVE_READS_FOR: 'another/project' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('sends credentials only to the fixed CNB origin and discards private errors', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(`${env.CNB_TOKEN} private stack`, { status: 403 }));
    const client = new CnbClient(() => readServerConfig(env), transport);
    const result = await client.read('repo-issue:r', '/-/issues/1');
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', dataState: 'not_written' } });
    expect(JSON.stringify(result)).not.toContain(env.CNB_TOKEN);
    expect(transport.mock.calls[0]?.[0]).toEqual(new URL('https://api.cnb.cool/fixture/project/-/issues/1'));
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${env.CNB_TOKEN}` } });
  });

  it('rechecks revocation before each request and does not silently fall back to public reads', async () => {
    let current: Record<string, string | undefined> = { ...env };
    const transport = vi.fn<typeof fetch>(async () => Response.json({ id: 'u1' }));
    const client = new CnbClient(() => readServerConfig(current), transport);
    expect((await client.read('account-profile:r', '/user', true)).ok).toBe(true);
    current = { ...current, CNB_TOKEN: undefined };
    expect(await client.read('account-profile:r', '/user', true)).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('denies missing scopes, unsafe paths, cancelled calls and exposed secret configuration', async () => {
    const transport = vi.fn<typeof fetch>();
    const client = new CnbClient(() => readServerConfig(env), transport);
    expect(await client.read('repo-code:r', '/-/git/head')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    for (const path of ['https://evil.example', '//evil.example', '/-/../private', '/-/x%2f..%2fsecret']) expect((await client.read('repo-issue:r', path)).ok).toBe(false);
    expect((await client.read('repo-issue:r', '/-/issues/1', false, AbortSignal.abort())).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    expect(readServerConfig({ ...env, VITE_CNB_TOKEN: 'private' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('fails on invalid or oversized JSON without emitting body text', async () => {
    for (const response of [new Response('secret', { headers: { 'Content-Type': 'application/json' } }), new Response('{}', { headers: { 'Content-Length': '999999999' } })]) {
      const client = new CnbClient(() => readServerConfig(env), async () => response);
      expect(await client.read('repo-issue:r', '/-/issues/1')).toMatchObject({ ok: false, error: { code: 'UPSTREAM' } });
    }
  });
  it('requires a new connection when the token or granted scope binding changes', async () => {
    let current = { ...env };
    const transport = vi.fn<typeof fetch>(async () => Response.json({ id: 'u1' }));
    const client = new CnbClient(() => readServerConfig(current), transport);
    expect((await client.read('account-profile:r', '/user', true)).ok).toBe(true);
    current = { ...current, CNB_TOKEN: 'different-secret' };
    expect(await client.read('account-profile:r', '/user', true)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { RepositorySlug, verifyCapabilities } from './capabilities';

const input = { repository: 'fixture/project', token: 'fixture-secret', authorizedRepository: 'fixture/project' };

describe('W01 explicitly authorized read-only capability probes', () => {
  it.each(['Yang.nby/yang', 'team.name/sub.group/project.name'])('preserves dotted namespaces when probing %s', async (repository) => {
    expect(RepositorySlug.safeParse(repository).success).toBe(true);
    const transport = vi.fn<typeof fetch>(async () => Response.json({ id: 'fixture' }));
    const result = await verifyCapabilities({ ...input, repository, authorizedRepository: repository }, transport);
    expect(result.ok).toBe(true);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cnb.cool/user', `https://api.cnb.cool/${repository}`,
    ]);
  });

  it('records only observed reads and keeps writes, model, filters and judge access pending', async () => {
    const transport = vi.fn(async () => Response.json({ id: 'u1' }));
    const result = await verifyCapabilities(input, transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reads).toEqual([{ capability: 'identity', state: 'observed', httpStatus: 200 }, { capability: 'repository', state: 'observed', httpStatus: 200 }]);
    expect(result.data.pending).toContain('git_atomic_write_and_readback');
    expect(result.data.pending).toContain('knowledge_filter_isolation');
    expect(result.data.pending).toContain('ai_model_and_cost');
    expect(result.data.pending).toContain('judge_read_only_access');
    for (const [url, options] of transport.mock.calls as unknown as [URL, RequestInit][]) {
      expect(url.origin).toBe('https://api.cnb.cool');
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('error');
    }
    expect(JSON.stringify(result)).not.toContain(input.token);
  });

  it.each([undefined, 'another/project'])('does not send a request without matching authorization (%s)', async (authorizedRepository) => {
    const transport = vi.fn();
    const result = await verifyCapabilities({ ...input, authorizedRepository }, transport);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    '../private', './repo', '.hidden/repo', 'Yang.nby/../private', 'Yang.nby/./repo',
    'Yang.nby//repo', 'Yang.nby/repo.git', 'Yang.nby/repo#fragment',
    'org/repo?token=x', 'https://evil.example/r', 'org/%2e%2e', 'Yang.nby\\repo',
  ])('rejects an unsafe repository (%s)', async (repository) => {
    const transport = vi.fn();
    const result = await verifyCapabilities({ ...input, repository, authorizedRepository: repository }, transport);
    expect(result.ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it('stops on authentication failure without emitting private error bodies', async () => {
    const transport = vi.fn(async () => new Response(`Authorization: ${input.token}; private text`, { status: 401 }));
    const result = await verifyCapabilities(input, transport);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.reads).toEqual([{ capability: 'identity', state: 'denied', httpStatus: 401 }]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(input.token);
  });

  it('records network failure without disclosing the error', async () => {
    const result = await verifyCapabilities(input, async () => { throw new Error(input.token); });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.reads[0]?.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(input.token);
  });

  it('does not read after cancellation', async () => {
    const transport = vi.fn();
    const result = await verifyCapabilities(input, transport, AbortSignal.abort());
    expect(result.ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
});

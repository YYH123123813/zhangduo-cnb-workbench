import { expect, it, vi } from 'vitest';
import { AIProviders } from './ai-providers';

it('keeps unconfigured requests offline and rejects arbitrary local URLs', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const gateway = new AIProviders(undefined, () => ({ ZHANGDUO_LOCAL_AI_URL: 'http://example.com/v1', ZHANGDUO_LOCAL_AI_MODEL: 'x' }), fetcher);
  expect((await gateway.send('local', [{ role: 'user', text: 'private' }])).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses the Responses API with storage disabled and never exposes the key', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: 'completed', model: 'configured-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] }] }));
  const gateway = new AIProviders(undefined, () => ({ ZHANGDUO_OPENAI_API_KEY: 'test-only-key', ZHANGDUO_OPENAI_MODEL: 'configured-model' }), fetcher);
  expect(await gateway.send('openai', [{ role: 'user', text: 'Question' }])).toEqual({ ok: true, data: { text: 'Answer', modelId: 'configured-model' } });
  expect(fetcher.mock.calls[0]![0]).toBe('https://api.openai.com/v1/responses');
  const options = fetcher.mock.calls[0]![1]!;
  expect(JSON.parse(String(options.body))).toMatchObject({ store: false, input: [{ role: 'user', content: 'Question' }] });
  expect(options.redirect).toBe('error'); expect(JSON.stringify(gateway.status())).not.toContain('test-only-key');
});
it('rejects tool calls and truncated outputs without retrying', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: 'completed', model: 'm', output: [{ type: 'function_call', name: 'write_repository' }] }));
  const gateway = new AIProviders(undefined, () => ({ ZHANGDUO_OPENAI_API_KEY: 'test', ZHANGDUO_OPENAI_MODEL: 'm' }), fetcher);
  expect((await gateway.send('openai', [{ role: 'user', text: 'Q' }])).ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('uses only the explicitly configured loopback model', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: 'local-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'local answer' } }] }));
  const gateway = new AIProviders(undefined, () => ({ ZHANGDUO_LOCAL_AI_URL: 'http://127.0.0.1:11434/v1', ZHANGDUO_LOCAL_AI_MODEL: 'local-model' }), fetcher);
  expect((await gateway.send('local', [{ role: 'user', text: 'test' }])).ok).toBe(true);
  expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
});

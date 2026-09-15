import { describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../../tests/integration/platform-fixture';
import { createServices } from './services';
import { DEFAULT_INTELLIGENCE, trainingWeight } from '../contracts/intelligence';
import type { ChatGateway } from './ai-providers';
import { randomUUID } from 'node:crypto';

describe('integrated intelligence settings and conversations', () => {
  it('uses importance, confirmed use counts and correction boost with a hard cap', () => {
    expect(trainingWeight(DEFAULT_INTELLIGENCE, { id: 'k', uses: 0, corrected: false })).toBe(1);
    expect(trainingWeight(DEFAULT_INTELLIGENCE, { id: 'k', uses: 2, corrected: true })).toBeGreaterThan(1.5);
    expect(trainingWeight({ ...DEFAULT_INTELLIGENCE, importance: { k: 0 } }, { id: 'k', uses: 9, corrected: true })).toBe(0);
    expect(trainingWeight({ ...DEFAULT_INTELLIGENCE, importance: { k: 5 } }, { id: 'k', uses: 100, corrected: true })).toBe(6);
  });
  it('has no successful unconfigured intelligence endpoint', async () => {
    const f = await platformFixture();
    try { expect((await createServices().intelligenceCommand!(f.ctx, { action: 'overview' })).ok).toBe(false); } finally { f.journal.close(); }
  });
  it('persists settings with CAS and binds the exact operation contents', async () => {
    const f = await platformFixture();
    try {
      const command = { action: 'settings' as const, confirmed: true as const, operationId: randomUUID(), expectedRevision: 0, settings: { ...DEFAULT_INTELLIGENCE, steps: 12 } };
      expect((await f.services.intelligenceCommand!(f.ctx, command)).ok).toBe(true);
      expect((await f.services.intelligenceCommand!(f.ctx, command)).ok).toBe(true);
      expect((await f.services.intelligenceCommand!(f.ctx, { ...command, settings: DEFAULT_INTELLIGENCE })).ok).toBe(false);
      expect((await f.services.intelligenceCommand!(f.ctx, { ...command, operationId: randomUUID() })).ok).toBe(false);
      const reloaded = createServices(f.options);
      const overview = await reloaded.intelligenceCommand!(f.ctx, { action: 'overview' });
      expect(overview).toMatchObject({ ok: true, data: { revision: 1, settings: { steps: 12 } } });
    } finally { f.journal.close(); }
  });
  it('preserves every turn, never sends twice, and rejects false contexts', async () => {
    const f = await platformFixture();
    const gateway: ChatGateway = { status: () => [{ id: 'local', ready: true, model: 'test' }], send: vi.fn(async () => ({ ok: true as const, data: { text: '测试回复，未写入正式知识。', modelId: 'test' } })) };
    const services = createServices({ ...f.options, aiGateway: gateway });
    try {
      const id = randomUUID();
      expect((await services.intelligenceCommand!(f.ctx, { action: 'create_chat', operationId: id, title: '测试', retentionDays: 30, confirmed: true })).ok).toBe(true);
      const send = { action: 'send' as const, id, operationId: randomUUID(), expectedRevision: 1, text: '你好', provider: 'local' as const, confirmed: true as const, modelConsent: true as const };
      expect((await services.intelligenceCommand!(f.ctx, send)).ok).toBe(true);
      expect((await services.intelligenceCommand!(f.ctx, send)).ok).toBe(true);
      expect(gateway.send).toHaveBeenCalledTimes(1);
      const chat = await services.intelligenceCommand!(f.ctx, { action: 'read_chat', id });
      expect(chat).toMatchObject({ ok: true, data: { messages: [{ role: 'user', text: '你好' }, { role: 'assistant' }] } });
      expect((await services.intelligenceCommand!({ ...f.ctx }, { action: 'read_chat', id })).ok).toBe(false);
    } finally { f.journal.close(); }
  });
});

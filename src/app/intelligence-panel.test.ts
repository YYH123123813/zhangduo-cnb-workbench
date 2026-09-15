import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TrainingRun } from '../contracts/intelligence';
import { TrainingResult } from './intelligence-panel';

const run: TrainingRun = { id: '11111111-1111-4111-8111-111111111111', mode: 'smoke', state: 'completed', cleanupReady: true, createdAt: '2026-09-16T00:00:00Z',
  settingsRevision: 2, datasetHash: 'fixture-only-hash', sampleCount: 16, nodeRefs: [], message: 'Synthetic training record',
  metrics: { beforeLoss: 4, afterLoss: 2, heldOutBefore: null, heldOutAfter: null, parameterDelta: 0.001, trainableParameters: 4,
    totalParameters: 10, steps: 5, weightEffect: 0.01, reloadVerified: true, validationGroups: 0 } };
const render = (value: TrainingRun, active = false) => renderToStaticMarkup(createElement(TrainingResult, {
  run: value, active, busy: false, samples: [], activate: () => {}, remove: () => {},
}));
describe('training record markup (not browser evidence)', () => {
  it('never gives smoke an activation control or a knowledge-quality certificate', () => {
    const html = render(run);
    expect(html).not.toContain('确认试用此适配器'); expect(html).toContain('不可启用为生产提取器');
    expect(html).toContain('不代表知识正确或能力认证'); expect(html).toContain('未测');
  });
  it('shows all lifecycle states and permits deletion only for completed or failed runs', () => {
    for (const [state, label] of Object.entries({ running: '训练中', completed: '已完成', failed: '失败', interrupted: '已中断', deleted: '已删除' })) {
      const html = render({ ...run, state: state as TrainingRun['state'], cleanupReady: state !== 'interrupted' });
      expect(html).toContain(label);
      expect(html.includes('删除本次训练产物')).toBe(['completed', 'failed'].includes(state));
    }
  });
  it('includes revision, sample scope, raw weight metric and historical artifact facts', () => {
    const html = render(run);
    expect(html).toContain('设置版本'); expect(html).toContain('样本数'); expect(html).toContain('实际步数');
    expect(html).toContain('权重影响量'); expect(html).toContain('fixture-only-hash');
    expect(render({ ...run, state: 'deleted' })).toContain('外部基础模型');
  });
  it('offers interrupted cleanup only when the server has verified it is safe', () => {
    expect(render({ ...run, state: 'interrupted', cleanupReady: false })).not.toContain('删除本次训练产物');
    expect(render({ ...run, state: 'interrupted', cleanupReady: true })).toContain('删除本次训练产物');
    expect(render({ ...run, cleanupReady: undefined })).toContain('产物清理能力尚未由服务器核验');
  });
});

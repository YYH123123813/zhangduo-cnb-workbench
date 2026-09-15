import { z } from 'zod';
import { CandidateOutputSchema } from '../src/contracts/candidates';
import type { ChatGateway } from '../src/platform/ai-providers';
import type { TrainingExecutor } from '../src/platform/training-runner';
import { failure } from '../src/platform/result';

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export const FixtureControl = z.enum(['complete', 'fail', 'hold']);
export function syntheticCandidates(text: string) {
  const input = z.object({ untrustedSegments: z.array(z.object({ id: z.string(), text: z.string() })) }).parse(JSON.parse(text));
  const segment = input.untrustedSegments.find((item) => item.text.trim()), quote = segment?.text.slice(0, 300) ?? '';
  return CandidateOutputSchema.parse({ candidates: segment ? [{ title: '合成候选：现场记录', question: '这段现场在什么条件下可以复用？', claim: quote,
    kind: 'method', whyKeep: '合成流程检查，等待人工判断', uncertainties: ['固定规则合成候选，不代表模型能力或知识正确。'],
    spans: [{ segmentId: segment.id, start: 0, end: quote.length, quote }] }] : [] });
}
export function syntheticGateway(): ChatGateway {
  return { status: () => [{ id: 'cnb', ready: false, model: 'CNB' }, { id: 'openai', ready: false, model: '' },
    { id: 'local', ready: true, model: 'synthetic-fixture-not-a-model' }], send: async (provider, messages, structured) => {
    if (provider !== 'local') return failure('NOT_CONFIGURED', '本预览只提供明确标记的合成回复。', 'choose_synthetic_provider');
    const text = messages.at(-1)?.text ?? '';
    await delay(text.includes('[fixture:delay]') ? 5000 : 350);
    if (text.includes('[fixture:unknown]')) throw Error('Explicit synthetic unknown outcome');
    if (text.includes('[fixture:fail]')) return failure('UPSTREAM', '显式合成模型失败。', 'review_synthetic_failure', 'preserved');
    if (structured) {
      try { return { ok: true, data: { text: JSON.stringify(syntheticCandidates(text)), modelId: 'synthetic-fixture-not-a-model' } }; }
      catch { return failure('NOT_IMPLEMENTED', '合成预览只支持来源绑定的候选提取，不模拟其他结构化能力。', 'continue_manually'); }
    }
    return { ok: true, data: { text: '合成预览回复（非真实模型）：此内容用于检查对话保存、人工交接和检索流程。知识仍需核对条件与来源。', modelId: 'synthetic-fixture-not-a-model' } };
  } };
}

// This executor is only injected into the explicitly simulated preview, never production or the real worker smoke.
export function simulatedTraining(control: () => z.infer<typeof FixtureControl>): TrainingExecutor & { shutdown(): Promise<void> } {
  const active = new Set<string>(), removed = new Set<string>();
  let stopping = false;
  const key = (workspace: string, mode: string, id: string) => JSON.stringify([workspace, mode, id]);
  return { ready: () => !stopping, pretrainedReady: () => !stopping,
    shutdown: async () => { stopping = true; while (active.size) await delay(100); },
    run: async (input) => {
      if (input.mode !== 'fixture' || stopping) throw Error('Simulated executor requires an active fixture');
      const id = key(input.workspace, input.mode, input.run.id); active.add(id);
      try {
        await delay(1200);
        while (!stopping && control() === 'hold') await delay(100);
        if (stopping) throw Error('Simulated executor is stopping');
        if (control() === 'fail') throw Error('Explicit simulated training failure');
        return { beforeLoss: 4, afterLoss: 3, heldOutBefore: 4, heldOutAfter: 3.5, parameterDelta: 0.5,
          trainableParameters: 8, totalParameters: 80, steps: input.settings.steps, weightEffect: 0.25, reloadVerified: true, validationGroups: 1 };
      } finally { active.delete(id); }
    },
    inspect: (workspace, mode, id) => active.has(key(workspace, mode, id)) ? 'running' : 'stopped',
    remove: (workspace, mode, id) => { const k = key(workspace, mode, id); if (mode !== 'fixture' || active.has(k)) throw Error('Simulation is still running'); removed.add(k); },
    infer: async (workspace, mode, id, text) => { if (mode !== 'fixture' || removed.has(key(workspace, mode, id))) throw Error('No simulated adapter'); return syntheticCandidates(text); },
  };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { CandidateOutputSchema } from '../../src/contracts/candidates';
import { IntelligenceSettingsSchema, TrainingRunSchema, trainingWeight, type TrainingSample } from '../../src/contracts/intelligence';

const root = process.cwd();
const supplied = process.argv[2];
assert(supplied && isAbsolute(supplied), 'Pass an absolute B synthetic smoke directory');
const directory = realpathSync(supplied);
const rel = relative(resolve('.local/fixture/intelligence-parallel/B'), directory);
assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Only B synthetic evidence is allowed');
const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as unknown;
const manifest = read('manifest.json') as { mode: string; synthetic: boolean; trainingGroups: string[]; validationGroups: string[] };
assert.equal(manifest.mode, 'smoke');
assert.equal(manifest.synthetic, true);
const metrics = TrainingRunSchema.shape.metrics.unwrap().parse(read('metrics.json'));
assert.equal(metrics.reloadVerified, true);
assert(metrics.parameterDelta > 0 && metrics.weightEffect > 0);
assert.equal(metrics.validationGroups, manifest.validationGroups.length);
assert(manifest.validationGroups.every((group) => !manifest.trainingGroups.includes(group)));

let candidatesChecked = 0;
for (const name of ['smoke-request.json', 'lora-request.synthetic.json']) {
  const request = JSON.parse(readFileSync(resolve(root, 'training/examples', name), 'utf8')) as { settings: unknown; samples: TrainingSample[] };
  const settings = IntelligenceSettingsSchema.parse(request.settings);
  for (const sample of request.samples) {
    assert(sample.id.startsWith('synthetic-') && sample.groupId.startsWith('synthetic-'));
    assert.equal(sample.weight, trainingWeight(settings, { id: sample.id, corrected: false, uses: 0 }));
    const source = JSON.parse(sample.input) as { untrustedSegments: { id: string; text: string }[] };
    const target = CandidateOutputSchema.parse(JSON.parse(sample.target));
    for (const candidate of target.candidates) {
      for (const span of candidate.spans) {
        const segment = source.untrustedSegments.find((s) => s.id === span.segmentId);
        assert(segment);
        assert.equal(segment.text.slice(span.start, span.end), span.quote);
      }
      candidatesChecked += 1;
    }
  }
}
const sources = ['src/contracts/intelligence.ts', 'src/contracts/candidates.ts', 'training/tests/check_contract.ts'];
const result = { synthetic: true, exitCode: 0, command: ['node', ...process.execArgv, ...process.argv.slice(1)],
  metricsSchemaVerified: true, exampleSettingsVerified: 2, exampleCandidatesVerified: candidatesChecked,
  exampleWeightsVerified: true, utf16SpansVerified: true,
  sourceSha256: Object.fromEntries(sources.map((name) => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')])) };
writeFileSync(resolve(directory, 'contract-check.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result, null, 2));

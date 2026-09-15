import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFiles } from './check-release.mjs';

const file = (name, text = '', extra = {}) => ({ name, content: Buffer.from(text), ...extra });
const audit = (files) => auditFiles(files, { requireFiles: false });

test('requires a complete submission by default', () => {
  assert.equal(auditFiles([]).passed, false);
});
test('accepts empty server-only secret examples', () => {
  assert.equal(audit([file('.env.example', 'CNB_TOKEN=\nZHANGDUO_OPENAI_API_KEY=\n')]).passed, true);
});
test('rejects private files and runtime artifacts, including nested secrets', () => {
  for (const name of ['.env', '.env.local', 'nested/.env', '.local/preview.json', 'training/vendor/x.py', 'a.sqlite-wal', 'model.safetensors', 'artifacts/source.zip', 'coordination/本机验收.md']) {
    assert.equal(audit([file(name)]).passed, false, name);
  }
});
test('rejects symlinks and submodules without reading their targets', () => {
  for (const mode of ['120000', '160000']) assert.equal(audit([file('source', '', { mode })]).passed, false);
});
test('detects a credential without reproducing its value', () => {
  const secret = 'ghp_' + 'x'.repeat(40);
  const result = audit([file('example.ts', secret)]);
  assert.equal(result.passed, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test('blocks nonempty example secret settings', () => {
  assert.equal(audit([file('.env.example', 'CNB_TOKEN=not-a-real-credential')]).passed, false);
});
test('allows only exact fake privacy fixtures in their original test paths', () => {
  const synthetic = 'sk-' + 'fixture_abcdefghijklmnopqrstuvwxyz';
  assert.equal(audit([file('src/features/capture/privacy.test.ts', synthetic)]).passed, true);
  assert.equal(audit([file('src/server/example.ts', synthetic)]).passed, false);
  assert.equal(audit([file('src/features/capture/privacy.test.ts', 'ghp_' + 'x'.repeat(40))]).passed, false);
});
test('checks relative and percent-encoded local Markdown links', () => {
  const result = audit([file('README.md', '[Guide](docs/%E6%BC%94%E7%A4%BA.md#start)\n![View](docs/ui.png)'), file('docs/演示.md'), file('docs/ui.png', '\0')]);
  assert.equal(result.passed, true);
});
test('rejects missing and out-of-repository link targets', () => {
  for (const link of ['missing.md', '../private.md', '/Users/example/secret']) {
    assert.equal(audit([file('README.md', `[Example](${link})`)]).passed, false, link);
  }
});
test('ignores fenced examples and external links', () => {
  assert.equal(audit([file('README.md', '```md\n[Example](missing.md)\n```\n[Reference](https://example.org)\n[Section](#section)')]).passed, true);
});
test('rejects unmerged index entries', () => {
  assert.equal(audit([file('source.ts', '', { stage: '2' })]).passed, false);
});

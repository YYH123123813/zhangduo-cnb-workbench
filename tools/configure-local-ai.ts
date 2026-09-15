import { mkdirSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { z } from 'zod';

const model = process.argv[2];
if (!model || !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw Error('Provide an installed Ollama model name');
const result = await fetch('http://127.0.0.1:11434/api/tags', { redirect: 'error', signal: AbortSignal.timeout(5000) });
const catalog = z.object({ models: z.array(z.object({ name: z.string() })) }).parse(await result.json());
if (!catalog.models.some((item) => item.name === model)) throw Error('Model must already exist locally; no download was attempted');
for (const path of ['.local', '.local/fixture']) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw Error('Unsafe project storage');
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
writeFileSync('.local/fixture/intelligence-runtime.json', JSON.stringify({ confirmed: true, model, baseUrl: 'http://127.0.0.1:11434/v1' }), { mode: 0o600, flag: 'wx' });
console.log('Local-only model profile created. Production credentials and CNB configuration were not changed.');

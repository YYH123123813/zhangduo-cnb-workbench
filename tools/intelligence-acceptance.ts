import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCAL_DEMO_KEY } from '../src/contracts/runtime';
import { CONTRACT_VERSION } from '../src/contracts/domain';
import { ChatSchema, IntelligenceCommandSchema, IntelligenceOverviewSchema, type IntelligenceMutation } from '../src/contracts/intelligence';

// Default is health-only. A must schedule every connection, synthetic mutation and real smoke job.
export async function runIntelligenceAcceptance(args: string[], transport: typeof fetch = fetch) {
  const [address, ...flags] = args;
  if (!address || flags.some((flag) => !['--chat', '--train', '--allow-fixture-mutations'].includes(flag))) {
    throw Error('Usage: intelligence-acceptance.ts <explicit loopback URL> [--allow-fixture-mutations --chat|--train]. No server is started.');
  }
  const base = new URL(address);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('An explicit loopback HTTP origin is required.');
  const mutations = flags.includes('--chat') || flags.includes('--train');
  if (mutations && !flags.includes('--allow-fixture-mutations')) throw Error('A must schedule mutations; add --allow-fixture-mutations only after independent authorization.');
  const id = randomUUID(), root = '.local/fixture/intelligence-parallel/D';
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const output = `${root}/shared-${id}.json`;
  const report = { id, contractVersion: CONTRACT_VERSION, startedAt: new Date().toISOString(), origin: base.origin,
    runtimeContractVersion: null as string | null,
    transport: transport === fetch ? 'http' : 'injected_synthetic_test',
    mode: 'not_verified', outcome: 'pending', scope: mutations ? 'authorized_fixture_mutations' : 'health_only',
    realCNB: false, paidAPI: false, realTrainingRequested: flags.includes('--train'), browserAcceptance: false,
    reads: 0, mutations: 0, operations: [] as { action: string; operationId: string; verify: string }[],
    chat: null as unknown, training: null as unknown, error: null as string | null };
  let cookie = '';
  async function request(path: string, body?: unknown): Promise<unknown> {
    if (body === undefined) report.reads++; else report.mutations++;
    const response = await transport(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(90_000), headers: { Origin: base.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json();
    if (envelope.meta?.mode !== 'fixture') throw Error('Refused non-fixture or unverifiable runtime. No automatic retry; do not use historical shared addresses.');
    const version = typeof envelope.meta.contractVersion === 'string' ? envelope.meta.contractVersion : null;
    if (path === '/api/health') report.runtimeContractVersion = version;
    if (mutations && version !== CONTRACT_VERSION) throw Error('Fixture contract does not match this source. Ask A to load matching code; no connection or mutation retry.');
    report.mode = 'fixture';
    if (!response.ok || !envelope.ok) throw Error('Original request was not verified. Read its operation receipt and current object; do not resend or create a replacement operation.');
    if (path === '/api/workspace/connect') {
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
      if (!cookie) throw Error('Fixture connection did not return a session.');
    }
    return envelope.data;
  }
  async function command(input: IntelligenceMutation) {
    const parsed = IntelligenceCommandSchema.parse(input);
    report.operations.push({ action: input.action, operationId: input.operationId, verify: `/api/intelligence/operations/${input.operationId}` });
    return request('/api/intelligence', parsed);
  }
  try {
    await request('/api/health');
    if (mutations) {
      await request('/api/workspace/connect', { connectionKey: LOCAL_DEMO_KEY, confirmed: true });
      let overview = IntelligenceOverviewSchema.parse(await request('/api/intelligence'));
      if (flags.includes('--chat')) {
        if (!overview.providers.some((p) => p.id === 'local' && p.ready)) throw Error('Local inference is not configured. No provider was changed and no model was downloaded.');
        const chat = ChatSchema.parse(await command({ action: 'create_chat', operationId: randomUUID(), confirmed: true,
          retentionDays: 30, title: 'Synthetic D acceptance: original receipt' }));
        const saved = ChatSchema.parse(await command({ action: 'send', id: chat.id, expectedRevision: chat.revision,
          operationId: randomUUID(), confirmed: true, modelConsent: true, provider: 'local',
          text: 'Synthetic test only. Explain why an unknown write result must be read back using its original identity.' }));
        if (saved.messages.length !== 2 || saved.status !== 'ready') throw Error('The complete synthetic conversation was not verified.');
        const archive = await command({ action: 'archive', id: chat.id, expectedRevision: saved.revision, operationId: randomUUID(), confirmed: true });
        report.chat = { id: chat.id, messageCount: saved.messages.length, archive };
      }
      if (flags.includes('--train')) {
        overview = IntelligenceOverviewSchema.parse(await request('/api/intelligence'));
        if (!overview.training.ready) throw Error('Training runtime is not installed. See training/README.md; this tool installs nothing.');
        const operationId = randomUUID();
        await command({ action: 'train', operationId, expectedRevision: overview.revision, mode: 'smoke',
          nodeIds: [], nodeRevisions: {}, trainingConsent: true, confirmed: true });
        for (let count = 0; count < 300; count++) {
          await new Promise((done) => setTimeout(done, 2000));
          const run = IntelligenceOverviewSchema.parse(await request('/api/intelligence')).runs.find((r) => r.id === operationId);
          if (!run) throw Error('Original training run is absent; absence is not proof that it never started.');
          if (run.state === 'running') continue;
          if (run.state !== 'completed' || !run.metrics?.reloadVerified || run.metrics.parameterDelta <= 0 || run.metrics.weightEffect <= 0)
            throw Error('Original smoke training was not verified. Inspect the original run; no automatic restart.');
          report.training = run;
          break;
        }
        if (!report.training) throw Error('Polling deadline reached. Read the original run; this does not authorize killing or restarting it.');
      }
    }
    report.outcome = 'passed';
    return report;
  } catch {
    report.outcome = 'failed';
    report.error = 'Runtime or original request was not verified. Read the original operation; do not repeat a mutation.';
    throw Error(`${report.error} Evidence: ${output}`);
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runIntelligenceAcceptance(process.argv.slice(2)).then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Acceptance failed'); process.exitCode = 1; });
}

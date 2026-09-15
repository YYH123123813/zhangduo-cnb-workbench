import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredFiles = [
  'README.md', '.env.example', '.gitignore', 'package.json', 'pnpm-lock.yaml',
  'src/app/App.tsx', 'src/server/app.ts', 'training/requirements.txt',
  'docs/比赛作品说明.md', 'docs/演示与复现.md', 'docs/验证记录.md',
];
const privatePaths = /(^|\/)(?:\.env(?:\..+)?|\.local|node_modules|dist|coverage|artifacts|\.DS_Store|\.venv|__pycache__|\.pytest_cache|playwright-report|test-results)(?:\/|$)|^training\/vendor\/|^coordination\/(?:AI接入并行|最终交付)\/|^coordination\/(?:本机验收|真实CNB初始化与读回验收|基线验收|窗口一接口公告)\.md$|\.(?:sqlite(?:-[^/]*)?|db(?:-[^/]*)?|pem|key|p12|pfx|safetensors|pt|pth|pyc|log)$/i;
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];

function withoutSyntheticCredentials(name, text) {
  const prefix = 'src/features/capture/';
  const allowed = new Map([
    [`${prefix}client.test.ts`, ['sk-' + 'fixture_abcdefghijklmnopqrstuvwxyz']],
    [`${prefix}redaction.test.ts`, ['sk-' + 'fixture_abcdefghijklmnopqrstuvwxyz']],
    [`${prefix}privacy.test.ts`, ['sk-' + 'fixture_abcdefghijklmnopqrstuvwxyz', 'ghp_' + 'abcdefghijklmnopqrstuvwxyz1234',
      'AKIA' + 'ABCDEFGHIJKLMNOP', ['-----BEGIN ' + 'PRIVATE KEY-----', 'fixture', '-----END PRIVATE KEY-----'].join('\\n')]],
  ]);
  // Only these exact fake values in the privacy regression fixtures are exempt.
  for (const value of allowed.get(name) ?? []) text = text.replaceAll(value, '[synthetic-credential-fixture]');
  return text;
}

export function auditFiles(entries, { requireFiles = true } = {}) {
  const errors = [];
  const files = new Map(entries.map((entry) => [entry.name, entry]));
  if (requireFiles) for (const name of requiredFiles) if (!files.has(name)) errors.push(`Missing release file: ${name}`);
  let bytes = 0;
  for (const { name, content, mode = '100644', stage = '0' } of entries) {
    if (!['100644', '100755'].includes(mode)) errors.push(`Non-regular tracked file: ${name}`);
    if (stage !== '0') errors.push(`Unmerged index entry: ${name}`);
    if (name !== '.env.example' && privatePaths.test(name)) errors.push(`Private/generated path: ${name}`);
    if (name.startsWith('/') || name.split('/').includes('..')) errors.push(`Unsafe path: ${name}`);
    bytes += content.length;
    if (content.length > 10 * 1024 * 1024) errors.push(`File exceeds 10 MiB: ${name}`);
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    if (credentialPatterns.some((pattern) => pattern.test(withoutSyntheticCredentials(name, text)))) errors.push(`Possible credential in: ${name} (value omitted)`);
    if (name === '.env.example') {
      for (const line of text.split(/\r?\n/)) {
        const field = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (field && /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(field[1]) && field[2].trim()) {
          errors.push(`Nonempty secret setting in .env.example: ${field[1]}`);
        }
      }
    }
    if (!name.endsWith('.md')) continue;
    const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '');
    for (const match of prose.matchAll(/!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] ?? match[2];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { errors.push(`Malformed link in: ${name}`); continue; }
      if (!decoded) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), decoded));
      const directory = `${resolved.replace(/\/$/, '')}/`;
      if (decoded.startsWith('/') || resolved.startsWith('../')) errors.push(`Link outside release: ${name} -> ${target}`);
      else if (!files.has(resolved) && ![...files.keys()].some((file) => file.startsWith(directory))) {
        errors.push(`Missing link target: ${name} -> ${target}`);
      }
    }
  }
  if (bytes > 30 * 1024 * 1024) errors.push('Tracked source exceeds 30 MiB; inspect large artifacts.');
  return { passed: errors.length === 0, fileCount: entries.length, bytes, errors };
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw Error('Cannot read Git index. Run from a complete clone or stage the intended release first.');
  return result.stdout;
}

export function readIndex() {
  const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    const [mode, oid, stage] = line.slice(0, separator).split(' ');
    return { mode, oid, stage, name: line.slice(separator + 1) };
  });
  const regular = entries.filter((entry) => ['100644', '100755'].includes(entry.mode));
  // Read index blobs, not working-tree paths: ignored files and symlink targets must never be opened.
  const blobs = git(['cat-file', '--batch'], { input: regular.map((entry) => `${entry.oid}\n`).join('') });
  let offset = 0;
  for (const entry of entries) {
    entry.content = Buffer.alloc(0);
    if (!['100644', '100755'].includes(entry.mode)) continue;
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString('ascii').split(' ');
    const size = Number(header[2]);
    if (header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw Error('Unexpected Git object response');
    offset = end + 1;
    entry.content = blobs.subarray(offset, offset + size);
    if (entry.content.length !== size || blobs[offset + size] !== 10) throw Error('Truncated Git object');
    offset += size + 1;
  }
  return entries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = auditFiles(readIndex());
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

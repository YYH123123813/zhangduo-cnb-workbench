import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--handoff-docs')) throw Error('Usage: node tools/check-boundaries.mjs [--handoff-docs]');
const checkHandoffDocs = args.includes('--handoff-docs');
const { workers } = JSON.parse(await readFile(path.join(root, 'coordination/assignments.json'), 'utf8'));
const errors = [];
const routes = new Set();
const taskIds = new Set();
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (/\.tsx?$/.test(file)) files.push(file);
  }
  return files;
}
for (const worker of workers) {
  const folder = path.join(root, '..', 'codex节点', worker.folder);
  for (const name of ['开始.md', '00_前置知识.md', '01_职责与边界.md', '02_逐节点任务.md', '03_交付报告.md', '04_接口申请.md']) {
    if (checkHandoffDocs && !await exists(path.join(folder, name))) errors.push(`Missing worker document: ${worker.folder}/${name}`);
  }
  for (const [id, name] of worker.tasks) {
    if (taskIds.has(id)) errors.push(`Duplicate task ID ${id}`);
    taskIds.add(id);
    if (checkHandoffDocs && !await exists(path.join(folder, '逐节点任务', `${id}_${name}.md`))) errors.push(`Missing task document: ${id}`);
  }
  for (const route of worker.routes) {
    if (routes.has(route)) errors.push(`Duplicate route ownership: ${route}`);
    routes.add(route);
  }
  if (worker.number === 1) continue;
  const featureRoot = path.join(root, 'src/features', worker.feature);
  for (const entry of ['client.tsx', 'server.ts', 'AGENTS.md']) {
    if (!await exists(path.join(featureRoot, entry))) errors.push(`Missing module entry ${worker.feature}/${entry}`);
  }
  for (const file of await walk(featureRoot)) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function inspect(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      if (specifier?.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        const relative = path.relative(path.join(root, 'src/features'), resolved);
        if (!relative.startsWith('..') && relative.split(path.sep)[0] !== worker.feature) errors.push(`Cross-feature import: ${path.relative(root, file)} -> ${specifier}`);
        if (/client\.tsx$/.test(file) && (/[/\\](platform|server)[/\\]/.test(resolved) || /[/\\]server$/.test(resolved))) errors.push(`Client imports server implementation: ${file}`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${workers.length} workers, ${taskIds.size} unique task IDs, ${routes.size} uniquely owned routes; no cross-feature imports.${checkHandoffDocs ? ' Handoff documents verified.' : ''}`);

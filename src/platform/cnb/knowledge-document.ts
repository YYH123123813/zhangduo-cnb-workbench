import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { ChangeSet, KnowledgeSnapshot, KnowledgeNode } from '../../contracts/domain';
import type { RequestContext, Result } from '../../contracts/api';
import { canonicalJson } from '../../contracts/hash';
import { failure } from '../result';
import { GitKnowledgeDocumentSchema } from './snapshot';

export type KnowledgeDocument = z.infer<typeof GitKnowledgeDocumentSchema>;
export const knowledgePath = (id: string) => `knowledge/nodes/${createHash('sha256').update(id).digest('hex')}.md`;
export const indexPath = (id: string) => knowledgePath(id).replace('knowledge/nodes/', 'knowledge-index/');
export function indexFiles(input: KnowledgeDocument): Record<string, string> {
  const document = GitKnowledgeDocumentSchema.parse(input);
  if (document.nodes.some((node) => node.workspaceId !== document.workspaceId)) throw new Error('Index workspace mismatch');
  const allowed = document.nodes.filter((node) => node.confirmation === 'confirmed' && node.lifecycle === 'active' && !document.excludedIds.includes(node.id));
  const files = Object.fromEntries(allowed.map((node) => [indexPath(node.id), nodeMarkdown(node, { ...document, relations: [] })]));
  if (Object.values(files).reduce((size, text) => size + Buffer.byteLength(text), 0) > 5_000_000) throw new Error('Index input exceeds its budget');
  return files;
}

export function snapshotDocument(snapshot: KnowledgeSnapshot): KnowledgeDocument {
  const revision = (value: string) => value === snapshot.revision ? '@snapshot' : value;
  return { schemaVersion: 1, workspaceId: snapshot.workspaceId,
    nodes: snapshot.nodes.map((node) => ({ ...node, revision: revision(node.revision) })),
    relations: snapshot.relations.map((edge) => ({ ...edge, source: { ...edge.source, revision: revision(edge.source.revision) }, target: { ...edge.target, revision: revision(edge.target.revision) } })),
    excludedIds: snapshot.excludedIds };
}

export function applyKnowledgeChanges(ctx: RequestContext, snapshot: KnowledgeSnapshot, changes: ChangeSet): Result<KnowledgeDocument> {
  const invalid = () => failure<KnowledgeDocument>('VALIDATION', 'ChangeSet has invalid identities, confirmations, versions or relation endpoints', 'review_changes', 'preserved');
  if (changes.workspaceId !== ctx.workspaceId || snapshot.workspaceId !== ctx.workspaceId || snapshot.revision !== changes.baseRevision) return failure('CONFLICT', 'Knowledge base revision changed', 'preview_again', 'preserved');
  const touched = [...changes.nodes.map((node) => node.id), ...changes.relations.map((edge) => edge.id)];
  if (new Set(touched).size !== touched.length || new Set(changes.withdrawnIds).size !== changes.withdrawnIds.length) return invalid();
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, structuredClone(node)]));
  const relations = new Map(snapshot.relations.map((edge) => [edge.id, structuredClone(edge)]));
  const excluded = new Set(snapshot.excludedIds);
  const changedNodes = new Set(changes.nodes.map((node) => node.id));
  for (const node of changes.nodes) {
    if (node.workspaceId !== ctx.workspaceId || relations.has(node.id) || node.confirmation !== 'confirmed' || node.confirmedBy !== ctx.actorId
      || node.revision !== (nodes.get(node.id)?.revision ?? changes.baseRevision)) return invalid();
    if (changes.withdrawnIds.includes(node.id) && node.lifecycle !== 'withdrawn') return invalid();
    nodes.set(node.id, { ...node, revision: '@snapshot' });
    if (node.lifecycle === 'withdrawn') excluded.add(node.id);
    else if (node.lifecycle === 'active') excluded.delete(node.id);
  }
  for (const edge of changes.relations) {
    if (edge.workspaceId !== ctx.workspaceId || nodes.has(edge.id) || !['confirmed', 'withdrawn'].includes(edge.state)
      || (edge.state === 'confirmed' && edge.confirmedBy !== ctx.actorId) || edge.source.objectId === edge.target.objectId) return invalid();
    const refs = [edge.source, edge.target];
    for (const ref of refs) {
      const target = nodes.get(ref.objectId);
      const prior = snapshot.nodes.find((node) => node.id === ref.objectId);
      if (!target || ref.workspaceId !== ctx.workspaceId || ref.revision !== (prior?.revision ?? changes.baseRevision)) return invalid();
      if (edge.state === 'confirmed' && (target.lifecycle === 'withdrawn' || excluded.has(target.id))) return invalid();
    }
    if (changes.withdrawnIds.includes(edge.id) && edge.state !== 'withdrawn') return invalid();
    relations.set(edge.id, { ...edge,
      source: { ...edge.source, revision: changedNodes.has(edge.source.objectId) ? '@snapshot' : edge.source.revision },
      target: { ...edge.target, revision: changedNodes.has(edge.target.objectId) ? '@snapshot' : edge.target.revision } });
    if (edge.state === 'withdrawn') excluded.add(edge.id); else excluded.delete(edge.id);
  }
  for (const id of changes.withdrawnIds) {
    const node = nodes.get(id), edge = relations.get(id);
    if (!node && !edge) return invalid();
    if (node) nodes.set(id, { ...node, lifecycle: 'withdrawn', revision: '@snapshot' });
    if (edge) relations.set(id, { ...edge, state: 'withdrawn' });
    excluded.add(id);
  }
  // A changed premise does not silently reapprove existing relationships. Their old refs stay frozen.
  const adjacency = new Map<string, string[]>();
  for (const edge of relations.values()) if (edge.type === 'supersedes' && edge.state === 'confirmed' && !excluded.has(edge.id)) {
    adjacency.set(edge.source.objectId, [...(adjacency.get(edge.source.objectId) ?? []), edge.target.objectId]);
  }
  const active = new Set<string>(), done = new Set<string>();
  function cycle(id: string): boolean {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    for (const target of adjacency.get(id) ?? []) if (cycle(target)) return true;
    active.delete(id); done.add(id); return false;
  }
  if ([...adjacency.keys()].some(cycle)) return invalid();
  const document = GitKnowledgeDocumentSchema.safeParse({ schemaVersion: 1, workspaceId: ctx.workspaceId, nodes: [...nodes.values()], relations: [...relations.values()], excludedIds: [...excluded] });
  if (!document.success || Buffer.byteLength(canonicalJson(document.data)) > 1_000_000) return invalid();
  return { ok: true, data: document.data };
}

const literal = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/([\\`*_[\]#])/g, '\\$1');
export function nodeMarkdown(node: KnowledgeNode, document: KnowledgeDocument): string {
  const edges = document.relations.filter((edge) => edge.source.objectId === node.id || edge.target.objectId === node.id);
  return [`# ${literal(node.title)}`, '', `Object: ${node.id}`, `Confirmation: ${node.confirmation}`, `Lifecycle: ${node.lifecycle}`, `Authorship: ${node.authorship}`, '',
    '## Question', literal(node.question), '', '## Statement', literal(node.humanStatement), '',
    '## Conditions', ...node.conditions.map((item) => `- [${item.status}] ${literal(item.text)}`), '',
    '## Boundaries', ...node.boundaries.map((text) => `- ${literal(text)}`), '',
    '## Sources', ...node.sources.map((source) => `- ${literal(source.title)} (${source.id}; ${source.support})\n  ${literal(source.excerpt)}\n  Limitation: ${literal(source.limitation)}`), '',
    '## Relations (Generated)', ...edges.map((edge) => `- ${edge.source.objectId} -> ${edge.type} -> ${edge.target.objectId} [${edge.state}]: ${literal(edge.rationale)}`), ''].join('\n');
}

export function knowledgeFiles(document: KnowledgeDocument): Record<string, string> {
  return { 'knowledge/snapshot.json': canonicalJson(document), ...Object.fromEntries(document.nodes.map((node) => [knowledgePath(node.id), nodeMarkdown(node, document)])) };
}

export function gitKnowledgeFiles(document: KnowledgeDocument): Record<string, string> {
  return { ...knowledgeFiles(document), ...indexFiles(document) };
}

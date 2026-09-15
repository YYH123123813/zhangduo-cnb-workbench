import type { Approval, DeletePlan } from '../../contracts/domain';
import { hashDeletePlan } from '../../contracts/hash';
import { ctx } from './fixtures.test-support';

export async function deletePlan(overrides: Partial<DeletePlan> = {}): Promise<DeletePlan> {
  const plan: DeletePlan = { id: 'delete-plan-1', workspaceId: ctx.workspaceId, objectIds: ['node-1'], baseRevision: 'fixture-r1', contentHash: '',
    layers: [{ name: 'worktree', supported: true, consequence: 'Remove current document', reversible: true }, { name: 'git_history', supported: false, consequence: 'History remains', reversible: false }, { name: 'index', supported: true, consequence: 'Remove derived vectors', reversible: false }], ...overrides };
  plan.contentHash = await hashDeletePlan(plan);
  return plan;
}
export function deleteApproval(plan: DeletePlan): Approval {
  return { id: 'delete-approval', actorId: ctx.actorId, workspaceId: ctx.workspaceId, purpose: 'delete', objectIds: plan.objectIds, contentHash: plan.contentHash, baseRevision: plan.baseRevision,
    approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
}

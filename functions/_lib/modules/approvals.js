/** PHASE 2 / Step 7 — approval workflow (edge side). */
import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { assertScope, assertExplicitScope } from '../scope.js';

const ENTITY_TABLES = {
  HQ_DEPOSIT: 'deposits_hq',
  CHEQUE_STATUS_CHANGE: 'cheques',
  GUARANTEE_RELEASE: 'guarantees'
};

async function assertApprovalScope(env, ctx, repo, approval) {
  const role = ctx.actor?.role;
  if (role === 'ADMIN' || role === 'AUDITOR') return;
  assertExplicitScope(ctx);
  const entity = ENTITY_TABLES[approval.entity_type];
  if (!entity) throw Object.assign(new Error('Unknown approval entity'), { code: 'FORBIDDEN', status: 403 });
  const parent = (await repo.get(entity, String(approval.entity_id))).data;
  assertScope(ctx, parent);
}

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'approvals.read');
  const repo = createRepository(env, ctx);
  const result = await repo.call('approval.list', 'approvals', {
    status: query.status || '',
    entityType: query.entityType || '',
    entityId: query.entityId || '',
    limit: query.limit ? Number(query.limit) : 200
  });

  const role = ctx.actor?.role;
  if (role === 'ADMIN' || role === 'AUDITOR') return result.data || [];
  const allowed = [];
  for (const approval of result.data || []) {
    try {
      await assertApprovalScope(env, ctx, repo, approval);
      allowed.push(approval);
    } catch (err) {
      // Skip approvals outside the caller's warehouse/branch scope.
    }
  }
  return allowed;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'approvals.read');
  const repo = createRepository(env, ctx);
  const approval = (await repo.call('approval.get', 'approvals', { approvalId: id })).data;
  await assertApprovalScope(env, ctx, repo, approval);
  return approval;
}

export async function decide(env, ctx, id, decision, body = {}) {
  requirePermission(ctx, 'approvals.decide');
  if (decision === 'reject' && !body.reason && !body.notes) {
    throw Object.assign(new Error('A rejection reason is required'), {
      code: 'VALIDATION_ERROR', status: 400
    });
  }
  const repo = createRepository(env, ctx);
  // Resolve first so scope is checked before any decision is written.
  const approval = (await repo.call('approval.get', 'approvals', { approvalId: id })).data;
  assertExplicitScope(ctx);
  await assertApprovalScope(env, ctx, repo, approval);
  const action = decision === 'approve' ? 'approval.approve' : 'approval.reject';
  return (await repo.call(action, 'approvals', {
    approvalId: id,
    notes: decision === 'approve' ? body.notes : (body.reason || body.notes)
  })).data;
}

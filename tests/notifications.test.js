/** PHASE 2 / Step 5 — notification fan-out, idempotency and read state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';

const CTX = { requestId: 'req-notif', ip: '192.0.2.9', actor: { userId: 'admin', role: 'ADMIN' } };

function harness() {
  const h = loadGs(
    [
      'apps-script/utils/errors.gs',
      'apps-script/utils/helpers.gs',
      'apps-script/services/notification-service.gs'
    ],
    {
      NOTIFICATION_TYPES: [
        'GUARANTEE_EXPIRY', 'CHEQUE_OVERDUE', 'CUSTODY_VARIANCE', 'FAILED_RECONCILIATION'
      ],
      NOTIFICATION_CHANNELS: ['IN_APP', 'EMAIL', 'SMS'],
      AuthService: {
        scopesFor(userId) {
          return userId === 'treasurer' ? [{ type: 'WAREHOUSE', id: 'W1' }] : [];
        }
      }
    }
  );
  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'admin', role_id: 'ROLE_ADMIN', status: 'ACTIVE'
  });
  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'treasurer', role_id: 'ROLE_TREASURY', status: 'ACTIVE'
  });
  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'other', role_id: 'ROLE_TREASURY', status: 'ACTIVE'
  });
  return h;
}

test('raise() fans out to active recipients and is idempotent', () => {
  const h = harness();
  const NotificationService = h.sandbox.NotificationService;
  const input = {
    notificationType: 'GUARANTEE_EXPIRY', entityType: 'guarantees',
    entityId: 'GRT1', bucket: 'DUE_7'
  };
  const first = NotificationService.raise(CTX, input);
  assert.equal(first.created, 3); // ADMIN + both TREASURY users
  assert.equal(NotificationService.raise(CTX, input).created, 0);

  const rows = h.store.rows.notifications;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.channel === 'IN_APP' && row.status === 'UNREAD'));
  assert.ok(rows.every((row) => row.delivery_status === 'N/A'));
  assert.ok(rows.every((row) => row.notification_id.includes('GRT1')));
});

test('warehouse scoping limits recipients to admins and matching treasurers', () => {
  const h = harness();
  const ids = h.sandbox.NotificationService.recipientsFor({
    notificationType: 'CHEQUE_OVERDUE', warehouse: 'W1'
  });
  assert.deepEqual([...ids].sort(), ['admin', 'treasurer']);
});

test('list/summary/markRead/markAllRead operate on the caller only', () => {
  const h = harness();
  const NotificationService = h.sandbox.NotificationService;
  NotificationService.raise(CTX, {
    notificationType: 'CHEQUE_OVERDUE', entityType: 'cheques', entityId: 'CHQ1'
  });
  NotificationService.raise(CTX, {
    notificationType: 'FAILED_RECONCILIATION', entityType: 'reconciliation_exceptions', entityId: 'REC1'
  });

  const adminList = NotificationService.list('admin', {});
  assert.equal(adminList.length, 2);
  assert.equal(NotificationService.list('treasurer', {}).length, 2);
  assert.equal(NotificationService.summary('admin').total, 2);
  assert.equal(NotificationService.summary('admin').byType.CHEQUE_OVERDUE, 1);

  const first = adminList[0].notification_id;
  const marked = NotificationService.markRead('admin', first);
  assert.equal(marked.status, 'READ');
  assert.ok(marked.read_at);
  assert.throws(
    () => NotificationService.markRead('other', first),
    (error) => error.code === 'FORBIDDEN'
  );
  assert.equal(NotificationService.summary('admin').total, 1);
  assert.equal(NotificationService.markAllRead('admin').updated, 1);
  assert.equal(NotificationService.summary('admin').total, 0);
});

test('EMAIL/SMS channels never claim a delivery that did not happen', () => {
  const h = harness();
  const NotificationService = h.sandbox.NotificationService;
  NotificationService.raise(CTX, {
    notificationType: 'GUARANTEE_EXPIRY', entityType: 'guarantees',
    entityId: 'GRT2', channel: 'EMAIL'
  });
  const row = h.store.rows.notifications[0];
  assert.equal(row.channel, 'EMAIL');
  assert.equal(row.delivery_status, 'PENDING');
});

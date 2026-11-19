/**
 * PHASE 2 / Step 5 — in-app notifications.
 * NotificationSender is pluggable: IN_APP is fully implemented; EMAIL/SMS are
 * future-ready and never fabricate a delivery success.
 */
var NotificationService = (function () {

  var TITLES = {
    GUARANTEE_EXPIRY: 'Guarantee expiring',
    CHEQUE_OVERDUE: 'Cheque overdue',
    CUSTODY_VARIANCE: 'Custody variance detected',
    FAILED_RECONCILIATION: 'Reconciliation failed'
  };

  function recipientsFor(input) {
    var roles = input.roles || ['ADMIN', 'TREASURY'];
    return SheetsAdapter.readRows('users').filter(function (user) {
      if (user.status !== 'ACTIVE') return false;
      var role = String(user.role_id || user.role || '').replace('ROLE_', '');
      if (roles.indexOf(role) < 0) return false;
      if (input.warehouse) {
        var scopes = AuthService.scopesFor(user.user_id);
        var scoped = scopes.some(function (scope) {
          return scope.type === 'WAREHOUSE' && scope.id === input.warehouse;
        });
        // Admin receives all notifications; scoped roles only their warehouse.
        if (!scoped && role !== 'ADMIN') return false;
      }
      return true;
    }).map(function (user) { return user.user_id; });
  }

  /** Idempotent per (type, entity, bucket, recipient). */
  function raise(ctx, input) {
    Errors.assert(NOTIFICATION_TYPES.indexOf(input.notificationType) >= 0,
      'VALIDATION_ERROR', 'Invalid notificationType');
    var userIds = input.userIds || recipientsFor(input);
    var created = [];

    userIds.forEach(function (userId) {
      var id = 'NOT_' + [input.notificationType, input.entityId || '', input.bucket || 'NA', userId]
        .join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
      if (SheetsAdapter.findRow('notifications', 'notification_id', id)) return;

      var channel = input.channel || 'IN_APP';
      var row = SheetsAdapter.insertRow('notifications', {
        notification_id: id,
        user_id: userId,
        notification_type: input.notificationType,
        entity_type: input.entityType || '',
        entity_id: input.entityId || '',
        title: input.title || TITLES[input.notificationType] || input.notificationType,
        body: input.body || '',
        channel: channel,
        status: 'UNREAD',
        created_at: Helpers.nowIso(),
        read_at: '',
        delivery_status: channel === 'IN_APP' ? 'N/A' : 'PENDING'
      });
      created.push(row.notification_id);
    });

    return { notificationIds: created, created: created.length };
  }

  function list(userId, query) {
    query = query || {};
    return SheetsAdapter.readRows('notifications', {
      where: function (row) {
        if (String(row.user_id) !== String(userId)) return false;
        if (query.status && row.status !== query.status) return false;
        if (query.type && row.notification_type !== query.type) return false;
        return true;
      },
      orderBy: 'created_at',
      limit: query.limit || 200
    });
  }

  function summary(userId) {
    var rows = list(userId, { status: 'UNREAD' });
    var result = { total: rows.length, byType: {} };
    rows.forEach(function (row) {
      result.byType[row.notification_type] = (result.byType[row.notification_type] || 0) + 1;
    });
    return result;
  }

  function markRead(userId, notificationId) {
    var row = SheetsAdapter.findRow('notifications', 'notification_id', notificationId);
    if (!row) Errors.notFound('notifications', notificationId);
    if (String(row.user_id) !== String(userId)) Errors.forbidden('Notification belongs to another user');
    var next = Helpers.clone(row);
    delete next._row;
    next.status = 'READ';
    next.read_at = Helpers.nowIso();
    return SheetsAdapter.writeRowByNumber('notifications', row._row, next);
  }

  function markAllRead(userId) {
    var rows = list(userId, { status: 'UNREAD' });
    rows.forEach(function (row) { markRead(userId, row.notification_id); });
    return { updated: rows.length };
  }

  return {
    raise: raise, list: list, summary: summary,
    markRead: markRead, markAllRead: markAllRead,
    recipientsFor: recipientsFor
  };
})();

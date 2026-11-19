/**
 * PHASE 2 / Step 6 — attachment metadata (DORMANT / NOT DEPLOYED).
 *
 * R2 is skipped in this rollout. This service is retained as reference code;
 * no attachment routes are mounted. Google Sheets is the only production
 * storage backend.
 */
var AttachmentService = (function () {

  var ENTITY_TYPES = ['CHEQUE', 'GUARANTEE', 'DEPOSIT'];

  function list(query) {
    query = query || {};
    return SheetsAdapter.readRows('attachments', {
      where: function (row) {
        if (query.entityType && row.entity_type !== query.entityType) return false;
        if (query.entityId && String(row.entity_id) !== String(query.entityId)) return false;
        return true;
      },
      orderBy: 'uploaded_at',
      descending: true,
      limit: query.limit || 200
    });
  }

  function find(id) {
    return SheetsAdapter.findRow('attachments', 'attachment_id', id);
  }

  function get(id) {
    var row = find(id);
    if (!row || row.is_deleted === true || row.is_deleted === 'TRUE') {
      Errors.notFound('attachments', id);
    }
    return row;
  }

  function create(ctx, data) {
    Errors.assert(ENTITY_TYPES.indexOf(data.entity_type) >= 0,
      'VALIDATION_ERROR', 'Invalid entity_type');
    Errors.assert(!Helpers.isEmpty(data.entity_id), 'VALIDATION_ERROR', 'entity_id is required');
    Errors.assert(!Helpers.isEmpty(data.file_name), 'VALIDATION_ERROR', 'file_name is required');
    Errors.assert(!Helpers.isEmpty(data.r2_key), 'VALIDATION_ERROR', 'r2_key is required');
    if (find(data.attachment_id)) Errors.conflict('Attachment already exists: ' + data.attachment_id);

    var row = SheetsAdapter.insertRow('attachments', {
      attachment_id: data.attachment_id,
      entity_type: data.entity_type,
      entity_id: String(data.entity_id),
      file_name: data.file_name,
      r2_key: data.r2_key,
      uploaded_by: data.uploaded_by || (ctx.actor && ctx.actor.userId) || 'system',
      uploaded_at: Helpers.nowIso(),
      content_type: data.content_type || 'application/octet-stream',
      size_bytes: Number(data.size_bytes || 0),
      checksum: data.checksum || '',
      is_deleted: false,
      deleted_at: '',
      deleted_by: ''
    });
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'attachments', entityId: row.attachment_id,
      oldValue: null, newValue: {
        entity_type: row.entity_type, entity_id: row.entity_id, file_name: row.file_name
      }, result: 'SUCCESS'
    });
    return row;
  }

  /** Soft-delete metadata; returns the r2_key so the edge can remove the object. */
  function softDelete(ctx, id) {
    var row = get(id);
    SheetsAdapter.softDeleteRow('attachments', id, (ctx.actor && ctx.actor.userId) || 'system');
    AuditService.write(ctx, {
      operation: 'DELETE', entityType: 'attachments', entityId: id,
      oldValue: { r2_key: row.r2_key, file_name: row.file_name },
      newValue: null, result: 'SUCCESS'
    });
    return { deleted: true, r2_key: row.r2_key };
  }

  return {
    list: list, get: get, find: find, create: create, softDelete: softDelete
  };
})();

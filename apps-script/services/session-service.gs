/**
 * PHASE 2 / Step 2 — server-side session store (tbl_sessions).
 *
 * Refresh tokens are opaque to this layer: only their SHA-256 hash is stored.
 * Rotation deliberately creates a SUCCESSOR row and revokes the predecessor so
 * that a replayed old token still matches a revoked row and can be detected.
 */
var SessionService = (function () {

  var REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function nowIso() { return new Date().toISOString(); }

  function create(ctx, input) {
    var row = {
      session_id: input.sessionId || Helpers.id('SES'),
      user_id: input.userId,
      refresh_token_hash: input.refreshTokenHash,
      device_info: input.deviceInfo || '',
      ip_address: input.ip || '',
      created_at: nowIso(),
      expires_at: input.expiresAt || new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
      revoked_at: ''
    };
    return SheetsAdapter.insertRow('sessions', row);
  }

  function findByHash(hash) {
    if (!hash) return null;
    return SheetsAdapter.findRow('sessions', 'refresh_token_hash', hash);
  }

  function findById(sessionId) {
    if (!sessionId) return null;
    return SheetsAdapter.findRow('sessions', 'session_id', sessionId);
  }

  /** Resolve the owner of a refresh-token hash without trusting client input. */
  function lookup(hash) {
    var row = findByHash(hash);
    if (!row) Errors.fail('REFRESH_INVALID', 'Unknown refresh token');
    if (row.expires_at && row.expires_at < nowIso()) {
      Errors.fail('REFRESH_INVALID', 'Refresh token expired');
    }
    return { userId: row.user_id, sessionId: row.session_id, expiresAt: row.expires_at };
  }

  function revoke(sessionId, reason) {
    var row = findById(sessionId);
    if (!row || row.revoked_at) return false;
    var next = Helpers.clone(row);
    delete next._row;
    next.revoked_at = nowIso();
    SheetsAdapter.writeRowByNumber('sessions', row._row, next);
    SecurityEventService.write({
      eventType: 'SESSION_REVOKED', userId: row.user_id,
      ip: (reason && reason.ip) || row.ip_address || '',
      details: { sessionId: sessionId, reason: (reason && reason.reason) || reason || 'LOGOUT' },
      severity: 'INFO'
    });
    return true;
  }

  function revokeAll(userId, reason) {
    var rows = SheetsAdapter.readRows('sessions').filter(function (row) {
      return String(row.user_id) === String(userId) && !row.revoked_at;
    });
    rows.forEach(function (row) { revoke(row.session_id, reason || 'LOGOUT_ALL'); });
    return { revoked: rows.length };
  }

  /**
   * Rotate a refresh token. Returns either { session, previousSessionId } or
   * { error: 'REFRESH_INVALID' | 'REFRESH_REUSE' }.
   */
  function rotate(ctx, input) {
    var old = findByHash(input.refreshTokenHash);
    if (!old) return { error: 'REFRESH_INVALID' };

    if (old.revoked_at) {
      // A rotated token is being replayed: contain the whole session family.
      revokeAll(old.user_id, 'REFRESH_REUSE');
      SecurityEventService.write({
        eventType: 'TOKEN_REUSE_DETECTED', userId: old.user_id,
        ip: input.ip || old.ip_address || '',
        details: { sessionId: old.session_id, userId: old.user_id },
        severity: 'CRITICAL'
      });
      return { error: 'REFRESH_REUSE' };
    }

    if (old.expires_at && old.expires_at < nowIso()) return { error: 'REFRESH_INVALID' };
    if (String(old.user_id) !== String(input.userId)) return { error: 'REFRESH_INVALID' };

    var created = create(ctx, {
      sessionId: input.newSessionId,
      userId: old.user_id,
      refreshTokenHash: input.newRefreshTokenHash,
      deviceInfo: input.deviceInfo || old.device_info,
      ip: input.ip || old.ip_address,
      expiresAt: input.expiresAt
    });
    revoke(old.session_id, { reason: 'ROTATION', ip: input.ip });
    return { session: created, previousSessionId: old.session_id };
  }

  function list(userId) {
    return SheetsAdapter.readRows('sessions', { orderBy: 'created_at' }).filter(function (row) {
      return String(row.user_id) === String(userId);
    }).map(function (row) {
      return {
        sessionId: row.session_id,
        deviceInfo: row.device_info || '',
        ipAddress: row.ip_address || '',
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at || ''
      };
    });
  }

  function get(sessionId) {
    return findById(sessionId);
  }

  return {
    create: create, findByHash: findByHash, findById: findById, lookup: lookup,
    revoke: revoke, revokeAll: revokeAll, rotate: rotate,
    list: list, get: get, REFRESH_TTL_MS: REFRESH_TTL_MS
  };
})();

/** Credential verification and identity resolution. JWT signing happens in Cloudflare Functions. */

var AuthService = (function () {
  var ITERATIONS = 2000;

  function bytesToHex(bytes) {
    return bytes.map(function (b) { return ('0' + ((b < 0 ? b + 256 : b).toString(16))).slice(-2); }).join('');
  }

  /**
   * PBKDF2-style iterated HMAC-SHA256. The salt is embedded in the stored hash
   * because tbl_users intentionally has no password_salt column:
   *   pbkdf2$<iterations>$<salt>$<digest>
   * Legacy 3-part hashes (pbkdf2$<iterations>$<digest>) remain verifiable when a
   * separate salt is supplied.
   */
  function hashPassword(password, salt, iterations) {
    var rounds = iterations || ITERATIONS;
    var actualSalt = salt || Utilities.getUuid();
    var digest = Utilities.computeHmacSha256Signature(actualSalt + '|1|' + password, password);
    var hex = bytesToHex(digest);
    for (var i = 2; i <= rounds; i++) {
      digest = Utilities.computeHmacSha256Signature(hex + '|' + i + '|' + password, password);
      hex = bytesToHex(digest);
    }
    return 'pbkdf2$' + rounds + '$' + actualSalt + '$' + hex;
  }

  function verifyPassword(password, salt, storedHash) {
    if (Helpers.isEmpty(password) || Helpers.isEmpty(storedHash)) return false;
    var parts = String(storedHash).split('$');
    if (parts[0] !== 'pbkdf2') return false;
    if (parts.length === 4) {
      return hashPassword(password, parts[2], Number(parts[1])) === storedHash;
    }
    if (parts.length === 3 && !Helpers.isEmpty(salt)) {
      // Legacy format kept for backwards compatibility.
      var legacy = 'pbkdf2$' + parts[1] + '$' + salt + '$' + parts[2];
      return hashPassword(password, salt, Number(parts[1])) === legacy;
    }
    return false;
  }

  function scopesFor(userId) {
    return SheetsAdapter.readRows('user_scopes', {
      where: function (row) { return row.user_id === userId; }
    }).map(function (row) {
      return { type: row.scope_type, id: row.scope_id_value };
    });
  }

  function publicUser(row) {
    return {
      userId: row.user_id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      role: row.role_id ? row.role_id.replace('ROLE_', '') : '',
      status: row.status,
      scopes: scopesFor(row.user_id)
    };
  }

  function permissionsFor(roleName) {
    return (ROLE_PERMISSION_MAP[roleName] || []).slice();
  }

  function login(username, password, ip) {
    Errors.assert(!Helpers.isEmpty(username) && !Helpers.isEmpty(password), 'VALIDATION_ERROR', 'Username and password are required');
    var user = SheetsAdapter.findRow('users', 'username', username);
    if (!user) {
      AuditService.write({ userId: 'anonymous', role: 'ANONYMOUS', ip: ip }, {
        operation: 'LOGIN_FAILED', entityType: 'users', entityId: username,
        oldValue: null, newValue: null, result: 'FAILURE', errorCode: 'INVALID_CREDENTIALS'
      });
      Errors.fail('INVALID_CREDENTIALS', 'Invalid username or password');
    }
    if (user.status !== 'ACTIVE') Errors.fail('ACCOUNT_DISABLED', 'Account is not active');
    if (Number(user.failed_attempts || 0) >= 5) Errors.fail('ACCOUNT_LOCKED', 'Account is locked');

    // Salt is embedded in password_hash; no separate password_salt column exists.
    if (!verifyPassword(password, '', user.password_hash)) {
      SheetsAdapter.updateRow('users', user.user_id, { failed_attempts: Number(user.failed_attempts || 0) + 1 }, user.version);
      AuditService.write({ userId: user.user_id, role: user.role_id, ip: ip }, {
        operation: 'LOGIN_FAILED', entityType: 'users', entityId: user.user_id,
        oldValue: null, newValue: null, result: 'FAILURE', errorCode: 'INVALID_CREDENTIALS'
      });
      Errors.fail('INVALID_CREDENTIALS', 'Invalid username or password');
    }

    SheetsAdapter.updateRow('users', user.user_id, { failed_attempts: 0, last_login_at: Helpers.nowIso() }, user.version);
    var identity = publicUser(user);
    AuditService.write({ userId: identity.userId, role: identity.role, ip: ip }, {
      operation: 'LOGIN', entityType: 'users', entityId: identity.userId,
      oldValue: null, newValue: { username: identity.username }, result: 'SUCCESS'
    });
    return { user: identity, permissions: permissionsFor(identity.role) };
  }

  function currentUser(userId) {
    var user = SheetsAdapter.findRow('users', 'user_id', userId);
    if (!user) Errors.notFound('users', userId);
    var identity = publicUser(user);
    return { user: identity, permissions: permissionsFor(identity.role) };
  }

  return {
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    login: login,
    currentUser: currentUser,
    scopesFor: scopesFor,
    permissionsFor: permissionsFor
  };
})();

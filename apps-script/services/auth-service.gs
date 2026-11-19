/** Credential verification and identity resolution. JWT signing happens in Cloudflare Functions. */

var AuthService = (function () {
  var ITERATIONS = 2000;
  // PHASE 2 / Step 11 — deterministic lockout policy.
  var MAX_FAILED_ATTEMPTS = 5;
  var LOCK_MINUTES = 30;

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

  /* ---- PHASE 2 / Step 11 — lockout ---------------------------------------- */

  /** Best-effort append to tbl_security_events; never breaks a login response. */
  function securityEvent(eventType, user, ip, details, severity) {
    if (typeof SecurityEventService === 'undefined' || !SecurityEventService.write) return;
    try {
      SecurityEventService.write({
        eventType: eventType,
        userId: user ? user.user_id : 'anonymous',
        ip: ip || '',
        severity: severity || 'WARNING',
        details: details || null
      });
    } catch (err) { /* logging must not break the operation that triggered it */ }
  }

  /**
   * Pure lock-state calculation — no sheet writes. A stored `locked_until`
   * whose timestamp has passed is reported as an expired lock so callers can
   * auto-unlock in the SAME update as the login result (one version bump).
   */
  function lockStatus(user) {
    var attempts = Number((user && user.failed_attempts) || 0);
    var raw = user ? user.locked_until : '';
    var untilMs = raw ? Date.parse(raw) : NaN;
    var nowMs = Date.now();

    if (!isNaN(untilMs)) {
      if (nowMs >= untilMs) {
        return { locked: false, expired: true, failedAttempts: 0, lockedUntil: '' };
      }
      return { locked: true, expired: false, failedAttempts: attempts, lockedUntil: String(raw) };
    }
    // Legacy Phase 1 rows locked by count alone (no timestamp yet).
    return {
      locked: attempts >= MAX_FAILED_ATTEMPTS,
      expired: false,
      failedAttempts: attempts,
      lockedUntil: ''
    };
  }

  /** ADMIN-only: clear failed attempts and the lock window, audit the change. */
  function unlockUser(userId, ctx) {
    var user = SheetsAdapter.findRow('users', 'user_id', userId);
    if (!user) Errors.notFound('users', userId);
    var before = { failed_attempts: user.failed_attempts || 0, locked_until: user.locked_until || '' };
    SheetsAdapter.updateRow('users', userId, { failed_attempts: 0, locked_until: '' }, user.version);
    securityEvent('ADMIN_UNLOCK', user, (ctx && ctx.ip) || '', {
      unlockedBy: (ctx && ctx.actor && ctx.actor.userId) || 'system'
    }, 'INFO');
    AuditService.write(ctx || { userId: 'system', role: 'ADMIN' }, {
      operation: 'ADMIN_UNLOCK',
      entityType: 'users', entityId: userId,
      oldValue: before,
      newValue: { failed_attempts: 0, locked_until: '' },
      result: 'SUCCESS'
    });
    return { userId: userId, unlocked: true };
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

    // PHASE 2 / Step 11 — time-bounded, self-healing lockout.
    var lock = lockStatus(user);
    if (lock.expired) {
      // The 30-minute window elapsed. Clear it as part of the single update
      // below rather than writing twice (which would bump version twice).
      user.failed_attempts = 0;
      user.locked_until = '';
    }
    if (lock.locked) {
      securityEvent('ACCOUNT_LOCKED', user, ip, {
        failedAttempts: lock.failedAttempts, lockedUntil: lock.lockedUntil
      });
      AuditService.write({ userId: user.user_id, role: user.role_id, ip: ip }, {
        operation: 'LOGIN_FAILED', entityType: 'users', entityId: user.user_id,
        oldValue: null, newValue: null, result: 'FAILURE', errorCode: 'ACCOUNT_LOCKED'
      });
      Errors.fail('ACCOUNT_LOCKED', 'Account is temporarily locked. Try again in 30 minutes.');
    }

    // Salt is embedded in password_hash; no separate password_salt column exists.
    if (!verifyPassword(password, '', user.password_hash)) {
      var attempts = Number(user.failed_attempts || 0) + 1;
      var failurePatch = { failed_attempts: attempts };
      var justLocked = attempts >= MAX_FAILED_ATTEMPTS;
      if (lock.expired) failurePatch.locked_until = '';
      if (justLocked) {
        failurePatch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
      }
      SheetsAdapter.updateRow('users', user.user_id, failurePatch, user.version);
      AuditService.write({ userId: user.user_id, role: user.role_id, ip: ip }, {
        operation: 'LOGIN_FAILED', entityType: 'users', entityId: user.user_id,
        oldValue: null, newValue: null, result: 'FAILURE',
        errorCode: justLocked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS'
      });
      if (justLocked) {
        securityEvent('ACCOUNT_LOCKED', user, ip, {
          failedAttempts: attempts, lockedUntil: failurePatch.locked_until
        });
      }
      Errors.fail(justLocked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
        justLocked ? 'Account is temporarily locked. Try again in 30 minutes.' : 'Invalid username or password');
    }

    var successPatch = { failed_attempts: 0, last_login_at: Helpers.nowIso() };
    if (lock.expired) successPatch.locked_until = '';
    SheetsAdapter.updateRow('users', user.user_id, successPatch, user.version);
    var identity = publicUser(user);
    AuditService.write({ userId: identity.userId, role: identity.role, ip: ip }, {
      operation: 'LOGIN', entityType: 'users', entityId: identity.userId,
      oldValue: null, newValue: { username: identity.username }, result: 'SUCCESS'
    });
    var mfaRequired = mfaRequiredFor(user);
    identity.mfaEnabled = user.mfa_enabled === true || user.mfa_enabled === 'TRUE';
    identity.mfaMethods = mfaMethodsFor(user);
    return {
      user: identity,
      permissions: permissionsFor(identity.role),
      mfaRequired: mfaRequired,
      mfaMethods: mfaMethodsFor(user)
    };
  }

  function currentUser(userId) {
    var user = SheetsAdapter.findRow('users', 'user_id', userId);
    if (!user) Errors.notFound('users', userId);
    var identity = publicUser(user);
    identity.mfaEnabled = user.mfa_enabled === true || user.mfa_enabled === 'TRUE';
    identity.mfaMethods = mfaMethodsFor(user);
    return { user: identity, permissions: permissionsFor(identity.role) };
  }

  /* ---- PHASE 2 / Step 3 — MFA -------------------------------------------- */

  function mfaPolicy() {
    var roles = SheetsAdapter.getSetting('auth.mfa.requiredRoles');
    if (typeof roles === 'string') {
      try { roles = JSON.parse(roles); } catch (e) { roles = []; }
    }
    return {
      enforce: SheetsAdapter.getSetting('auth.mfa.enforce') === true ||
        SheetsAdapter.getSetting('auth.mfa.enforce') === 'TRUE',
      requiredRoles: Array.isArray(roles) ? roles : ['ADMIN', 'TREASURY']
    };
  }

  function mfaRequiredFor(user) {
    var enabled = user.mfa_enabled === true || user.mfa_enabled === 'TRUE';
    if (enabled) return true;
    var policy = mfaPolicy();
    return policy.enforce && policy.requiredRoles.indexOf(String(user.role_id || user.role || '').replace('ROLE_', '')) >= 0;
  }

  function mfaMethodsFor(user) {
    if (user.mfa_secret) return ['TOTP'];
    var enabled = user.mfa_enabled === true || user.mfa_enabled === 'TRUE';
    return enabled ? ['EMAIL_OTP'] : ['TOTP', 'EMAIL_OTP'];
  }

  function patchUser(userId, patch) {
    var row = SheetsAdapter.findRow('users', 'user_id', userId);
    if (!row) Errors.notFound('users', userId);
    var next = Helpers.clone(row);
    delete next._row;
    Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
    return SheetsAdapter.writeRowByNumber('users', row._row, next);
  }

  function setMfaSecret(userId, secret) {
    patchUser(userId, { mfa_secret: secret || '' });
    return { saved: true, methods: ['TOTP'] };
  }

  function getMfaSecret(userId) {
    var row = SheetsAdapter.findRow('users', 'user_id', userId);
    if (!row) Errors.notFound('users', userId);
    return { secret: row.mfa_secret || '' };
  }

  function deliverOtp(input) {
    var message = 'Your Collections Management verification code is ' +
      input.code + '. It expires in 5 minutes.';
    try {
      if (typeof MailApp !== 'undefined' && input.email) {
        MailApp.sendEmail({
          to: input.email,
          subject: 'CMS verification code',
          body: message
        });
        return { delivered: true, channel: 'EMAIL' };
      }
    } catch (err) {
      // Fall through to the in-app channel; delivery must not block login.
    }
    if (typeof SecurityEventService !== 'undefined') {
      SecurityEventService.write({
        eventType: 'MFA_OTP_ISSUED', userId: input.userId, ip: input.ip,
        severity: 'INFO',
        details: { channel: 'INAPP', emailSet: !!input.email }
      });
    }
    return { delivered: false, channel: 'INAPP' };
  }

  function setRecoveryCodes(userId, hashes) {
    SheetsAdapter.setSetting('mfa.recovery.' + userId, JSON.stringify(hashes || []),
      'Hashed MFA recovery codes', 'mfa-service');
    return { saved: (hashes || []).length };
  }

  function verifyRecoveryCode(userId, hash) {
    var raw = SheetsAdapter.getSetting('mfa.recovery.' + userId);
    var hashes = [];
    try { hashes = raw ? JSON.parse(raw) : []; } catch (e) { hashes = []; }
    var index = hashes.indexOf(hash);
    if (index < 0) return { valid: false, remaining: hashes.length };
    hashes.splice(index, 1); // single use
    setRecoveryCodes(userId, hashes);
    return { valid: true, remaining: hashes.length };
  }

  function setMfaEnabled(userId, enabled) {
    var row = SheetsAdapter.findRow('users', 'user_id', userId);
    if (!row) Errors.notFound('users', userId);
    if (!enabled) {
      var policy = mfaPolicy();
      var role = String(row.role_id || row.role || '').replace('ROLE_', '');
      if (policy.enforce && policy.requiredRoles.indexOf(role) >= 0) {
        Errors.forbidden('MFA is required by policy for this role');
      }
    }
    patchUser(userId, { mfa_enabled: !!enabled });
    return { mfaEnabled: !!enabled };
  }

  return {
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    login: login,
    currentUser: currentUser,
    lockStatus: lockStatus,
    unlockUser: unlockUser,
    MAX_FAILED_ATTEMPTS: MAX_FAILED_ATTEMPTS,
    LOCK_MINUTES: LOCK_MINUTES,
    scopesFor: scopesFor,
    permissionsFor: permissionsFor,
    mfaPolicy: mfaPolicy,
    mfaRequiredFor: mfaRequiredFor,
    mfaMethodsFor: mfaMethodsFor,
    setMfaSecret: setMfaSecret,
    getMfaSecret: getMfaSecret,
    setMfaEnabled: setMfaEnabled,
    deliverOtp: deliverOtp,
    setRecoveryCodes: setRecoveryCodes,
    verifyRecoveryCode: verifyRecoveryCode
  };
})();

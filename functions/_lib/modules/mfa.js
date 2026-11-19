/** PHASE 2 / Step 3 — MFA enrolment, challenge verification and disable. */
import { callGas } from '../gas-client.js';
import { verifyAccessToken, createSessionPair } from '../auth.js';
import {
  generateTotpSecret, provisioningUri, generateRecoveryCodes,
  issueEmailOtp, verifyEmailOtp, verifyTotp, sha256Hex,
  securityEvent, mfaError
} from '../mfa.js';

const METHODS = new Set(['TOTP', 'EMAIL_OTP', 'RECOVERY']);

async function identityFor(env, ctx) {
  const result = await callGas(env, ctx, 'auth.me', 'users', {
    userId: ctx.actor.userId, ip: ctx.ip || ''
  });
  return result.data;
}

/** Resolve the challenge subject: an mfaToken (login) or the access token. */
async function subjectFor(env, ctx, body) {
  if (body.mfaToken) {
    let claims;
    try {
      claims = await verifyAccessToken(env, body.mfaToken, {
        audience: 'cms-mfa', skipRevocation: true
      });
    } catch (err) {
      throw mfaError('MFA_CHALLENGE_EXPIRED', 'Verification challenge expired.');
    }
    return { userId: claims.sub, challenge: true, amr: claims.amr || ['pwd'] };
  }
  return { userId: ctx.actor.userId, challenge: false, amr: ['pwd'] };
}

async function assertCode(env, ctx, userId, type, code) {
  if (!METHODS.has(type)) throw mfaError('MFA_INVALID', 'Unsupported MFA method.');
  if (!/^[A-Za-z0-9]{6,16}$/.test(String(code || ''))) {
    throw mfaError('MFA_INVALID', 'A 6-digit code or recovery code is required.');
  }

  if (type === 'EMAIL_OTP') {
    return verifyEmailOtp(env, ctx, userId, code);
  }

  if (type === 'RECOVERY') {
    const result = await callGas(env, ctx, 'mfa.recovery.verify', 'users', {
      userId, hash: await sha256Hex(String(code).toUpperCase())
    });
    if (!result.data.valid) throw mfaError('MFA_INVALID', 'Invalid recovery code.');
    return true;
  }

  const secretResult = await callGas(env, ctx, 'mfa.secret.get', 'users', { userId });
  if (!(await verifyTotp(secretResult.data.secret, code))) {
    await securityEvent(env, ctx, userId, 'MFA_CHALLENGE_FAILED', 'WARNING');
    throw mfaError('MFA_INVALID', 'Incorrect authenticator code.');
  }
  return true;
}

export async function enroll(env, ctx, body = {}) {
  const userId = ctx.actor.userId;
  const type = String(body.type || 'TOTP').toUpperCase();

  if (type === 'TOTP') {
    const secret = generateTotpSecret();
    const recovery = await generateRecoveryCodes();
    await callGas(env, ctx, 'mfa.secret.set', 'users', { userId, secret });
    await callGas(env, ctx, 'mfa.recovery.set', 'users', { userId, hashes: recovery.hashes });
    await securityEvent(env, ctx, userId, 'MFA_ENROLLED', 'INFO', { type });
    return {
      type,
      secret,
      provisioningUri: provisioningUri(ctx.actor.username || userId, secret),
      recoveryCodes: recovery.codes,
      enrolled: true
    };
  }

  if (type === 'EMAIL_OTP') {
    const identity = await identityFor(env, ctx);
    const delivery = await issueEmailOtp(env, ctx, userId, identity.user?.email || '');
    return { type, ...delivery, enrolled: false };
  }

  throw mfaError('MFA_INVALID', 'Unsupported enrolment type.');
}

export async function verify(env, ctx, body = {}) {
  const { userId, challenge, amr } = await subjectFor(env, ctx, body);
  const type = String(body.type || 'TOTP').toUpperCase();
  const code = String(body.code || '');

  await assertCode(env, ctx, userId, type, code);

  // Enrolment confirmation: /auth/mfa/verify called with a normal access token
  // after /auth/mfa/enroll. No new session is issued in that case.
  if (!challenge) {
    await callGas(env, ctx, 'mfa.enable', 'users', { userId });
    await securityEvent(env, ctx, userId, 'MFA_ENABLED', 'INFO', { type });
    return { verified: true, mfaEnabled: true, type };
  }

  // Login challenge: complete the MFA step and issue the full token pair.
  const identity = await callGas(env, ctx, 'auth.me', 'users', { userId, ip: ctx.ip || '' });
  const row = await callGas(env, ctx, 'mfa.policy', 'users', {});
  const policyRequired = (row.data.requiredRoles || []).includes(identity.data.user.role);
  if (policyRequired || identity.data.user.mfaEnabled) {
    await callGas(env, ctx, 'mfa.enable', 'users', { userId });
  }
  const methods = [...new Set([...amr, type])];
  const session = await createSessionPair(env, ctx, identity.data.user, identity.data.permissions, methods);
  await securityEvent(env, ctx, userId, 'MFA_VERIFIED', 'INFO', { type });
  return { ...session, mfaVerified: true };
}

export async function disable(env, ctx, body = {}) {
  const userId = ctx.actor.userId;
  const type = String(body.type || 'TOTP').toUpperCase();
  await assertCode(env, ctx, userId, type, String(body.code || ''));
  await callGas(env, ctx, 'mfa.disable', 'users', { userId });
  await securityEvent(env, ctx, userId, 'MFA_DISABLED', 'WARNING', { type });
  return { disabled: true };
}

/** Re-send an email OTP (enrolment or login) without re-issuing a challenge token. */
export async function resend(env, ctx, body = {}) {
  const userId = ctx.actor.userId;
  const identity = await identityFor(env, ctx);
  const delivery = await issueEmailOtp(env, ctx, userId, identity.user?.email || '');
  return { ...delivery, type: 'EMAIL_OTP' };
}

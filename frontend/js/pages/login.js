/** Login shell, including the PHASE 2 / Step 3 MFA challenge step. */
import { api } from '../api/client.js';
import { startSession, setPermissions, updateUser } from '../store.js';
import { navigate } from '../router.js';
import { valueOf } from '../utils/dom.js';

function showError(root, message) {
  const box = root.querySelector('#login-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function clearError(root) {
  const box = root.querySelector('#login-error');
  if (box) { box.hidden = true; box.textContent = ''; }
}

async function completeLogin(session) {
  // Store the tokens first so /auth/me is authenticated. Permissions are
  // hydrated from /auth/me and also live in the JWT for edge-side RBAC.
  startSession({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
    user: session.user,
    permissions: []
  });
  try {
    const me = await api.get('/auth/me');
    if (me.user) updateUser(me.user);
    setPermissions(me.permissions || []);
  } catch (e) { /* edge RBAC still enforces permissions from the JWT */ }
  navigate('/dashboard', { replace: true });
}

function methodOptions(methods) {
  return (methods || []).map((method) => {
    const label = method === 'TOTP' ? 'Authenticator app'
      : method === 'EMAIL_OTP' ? 'Email code'
        : method === 'RECOVERY' ? 'Recovery code' : method;
    return `<option value="${method}">${label}</option>`;
  }).join('');
}

export default {
  title: 'Sign in',
  async render() {
    return `
      <div class="login-page">
        <div class="login-card">
          <div class="login-head">
            <div class="brand-mark">CM</div>
            <h1 id="login-title">Collections Management</h1>
            <p id="login-subtitle">Sign in to access your workspace</p>
          </div>
          <div id="login-error" class="form-error" hidden></div>

          <form id="login-form" class="form-stack" novalidate>
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" type="text" autocomplete="username" required autofocus>
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required>
            </div>
            <button class="btn btn-primary btn-block" type="submit" id="login-submit">Sign in</button>
          </form>

          <form id="mfa-form" class="form-stack" novalidate hidden>
            <div class="field">
              <label for="mfa-type">Method</label>
              <select id="mfa-type" name="mfa-type"></select>
            </div>
            <div class="field">
              <label for="mfa-code">Verification code</label>
              <input id="mfa-code" name="mfa-code" type="text" inputmode="numeric"
                     autocomplete="one-time-code" maxlength="16" required>
            </div>
            <button class="btn btn-primary btn-block" type="submit" id="mfa-submit">Verify</button>
            <button class="btn btn-ghost btn-block" type="button" id="mfa-resend">Resend email code</button>
            <button class="btn btn-ghost btn-block" type="button" id="mfa-back">Back to sign in</button>
          </form>

          <div class="login-foot">Authorized personnel only · Sessions expire after 15 minutes</div>
        </div>
      </div>`;
  },
  async mounted(root) {
    const form = root.querySelector('#login-form');
    if (!form) return;
    let challenge = null;

    function showLogin() {
      form.hidden = false;
      root.querySelector('#mfa-form').hidden = true;
      const title = root.querySelector('#login-title');
      const subtitle = root.querySelector('#login-subtitle');
      if (title) title.textContent = 'Collections Management';
      if (subtitle) subtitle.textContent = 'Sign in to access your workspace';
      clearError(root);
    }

    function showMfa(session) {
      challenge = session;
      form.hidden = true;
      root.querySelector('#mfa-form').hidden = false;
      const type = root.querySelector('#mfa-type');
      type.innerHTML = methodOptions(session.methods || ['TOTP', 'EMAIL_OTP']);
      const title = root.querySelector('#login-title');
      const subtitle = root.querySelector('#login-subtitle');
      if (title) title.textContent = 'Two-factor verification';
      if (subtitle) subtitle.textContent = 'One more step to secure your account';
      root.querySelector('#mfa-code').focus();
      clearError(root);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearError(root);
      const username = valueOf('#username', root);
      const password = root.querySelector('#password')?.value || '';
      if (!username || !password) {
        showError(root, 'Username and password are required.');
        return;
      }
      const submit = root.querySelector('#login-submit');
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        const session = await api.post('/auth/login', {
          username,
          password,
          deviceInfo: navigator.userAgent || ''
        });
        if (session.mfaRequired) { showMfa(session); return; }
        await completeLogin(session);
      } catch (err) {
        showError(root, err.message || 'Unable to sign in.');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    });

    root.querySelector('#mfa-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!challenge) return;
      clearError(root);
      const code = valueOf('#mfa-code', root);
      const type = valueOf('#mfa-type', root) || 'TOTP';
      if (!code) { showError(root, 'Enter the verification code.'); return; }
      const submit = root.querySelector('#mfa-submit');
      submit.disabled = true;
      submit.textContent = 'Verifying…';
      try {
        // The challenge token must travel as Bearer (middleware requires it).
        // Keep mfaToken in the body as well for the documented server contract.
        await completeLogin(await api.post('/auth/mfa/verify', {
          mfaToken: challenge.mfaToken, code, type
        }, { authToken: challenge.mfaToken }));
      } catch (err) {
        showError(root, err.message || 'Verification failed.');
        submit.disabled = false;
        submit.textContent = 'Verify';
      }
    });

    root.querySelector('#mfa-resend').addEventListener('click', async () => {
      if (!challenge) return;
      clearError(root);
      try {
        await api.post('/auth/mfa/resend', {}, { authToken: challenge.mfaToken });
        showError(root, 'A new email code has been sent.');
      } catch (err) {
        showError(root, err.message || 'Unable to resend the code.');
      }
    });

    root.querySelector('#mfa-back').addEventListener('click', () => {
      challenge = null;
      showLogin();
    });
  }
};

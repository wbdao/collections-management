/** Login shell. */
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

export default {
  title: 'Sign in',
  async render() {
    return `
      <div class="login-page">
        <div class="login-card">
          <div class="login-head">
            <div class="brand-mark">CM</div>
            <h1>Collections Management</h1>
            <p>Sign in to access your workspace</p>
          </div>
          <form id="login-form" class="form-stack" novalidate>
            <div id="login-error" class="form-error" hidden></div>
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
          <div class="login-foot">Authorized personnel only · Sessions expire after 8 hours</div>
        </div>
      </div>`;
  },
  async mounted(root) {
    const form = root.querySelector('#login-form');
    if (!form) return;
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
        const session = await api.post('/auth/login', { username, password });
        // Store the token first so /auth/me is authenticated. The login response
        // intentionally omits permissions; they are hydrated from /auth/me and
        // also live in the JWT for edge-side RBAC.
        startSession({
          accessToken: session.accessToken,
          user: session.user,
          permissions: []
        });
        try {
          const me = await api.get('/auth/me');
          if (me.user) updateUser(me.user);
          setPermissions(me.permissions || []);
        } catch (e) { /* edge RBAC still enforces permissions from the JWT */ }
        navigate('/dashboard', { replace: true });
      } catch (err) {
        showError(root, err.message || 'Unable to sign in.');
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    });
  }
};

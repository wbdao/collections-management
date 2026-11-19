/** Minimal observable session store. PHASE 2 / Step 2: refresh + session state. */
import { STORAGE_KEYS } from './config.js';

const listeners = new Set();

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

const state = {
  token: localStorage.getItem(STORAGE_KEYS.TOKEN) || '',
  refreshToken: localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN) || '',
  sessionId: localStorage.getItem(STORAGE_KEYS.SESSION) || '',
  user: readStored(STORAGE_KEYS.USER, null),
  permissions: readStored(STORAGE_KEYS.PERMISSIONS, [])
};

function notify() {
  listeners.forEach((listener) => listener(getState()));
}

export function getState() {
  return { ...state, authenticated: Boolean(state.token) };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isAuthenticated() {
  return Boolean(state.token);
}

export function can(permission) {
  if (!permission) return true;
  return (state.permissions || []).includes(permission) || state.permissions?.includes('*');
}

export function hasRole(role) {
  return state.user?.role === role;
}

/** Read tokens from storage so concurrent tabs and the API client stay in sync. */
export function getSessionTokens() {
  return {
    token: localStorage.getItem(STORAGE_KEYS.TOKEN) || '',
    refreshToken: localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN) || '',
    sessionId: localStorage.getItem(STORAGE_KEYS.SESSION) || ''
  };
}

function persistTokens(tokens) {
  if (tokens.accessToken !== undefined) {
    state.token = tokens.accessToken;
    localStorage.setItem(STORAGE_KEYS.TOKEN, tokens.accessToken);
  }
  if (tokens.refreshToken !== undefined) {
    state.refreshToken = tokens.refreshToken;
    localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, tokens.refreshToken);
  }
  if (tokens.sessionId !== undefined) {
    state.sessionId = tokens.sessionId;
    localStorage.setItem(STORAGE_KEYS.SESSION, tokens.sessionId);
  }
}

export function startSession({ accessToken, refreshToken, sessionId, user, permissions }) {
  persistTokens({
    accessToken: accessToken || '',
    refreshToken: refreshToken || '',
    sessionId: sessionId || ''
  });
  state.user = user || null;
  state.permissions = permissions || (user && user.permissions) || [];
  localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user || {}));
  // Permissions are also embedded in the JWT; refresh from /auth/me on load.
  localStorage.setItem(STORAGE_KEYS.PERMISSIONS, JSON.stringify(state.permissions));
  notify();
}

/** Called by the refresh interceptor after a successful /auth/refresh. */
export function applyTokens(tokens) {
  persistTokens(tokens);
  notify();
}

export function setPermissions(permissions) {
  state.permissions = permissions || [];
  localStorage.setItem(STORAGE_KEYS.PERMISSIONS, JSON.stringify(state.permissions));
  notify();
}

export function updateUser(user) {
  state.user = user || state.user;
  localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(state.user || {}));
  notify();
}

export function clearSessionStorage() {
  state.token = '';
  state.refreshToken = '';
  state.sessionId = '';
  state.user = null;
  state.permissions = [];
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.SESSION);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.PERMISSIONS);
}

export function endSession() {
  clearSessionStorage();
  notify();
}

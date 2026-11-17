/** Minimal observable session store. */
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

export function startSession({ accessToken, user, permissions }) {
  state.token = accessToken;
  state.user = user || null;
  state.permissions = permissions || (user && user.permissions) || [];
  localStorage.setItem(STORAGE_KEYS.TOKEN, accessToken);
  localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user || {}));
  // Permissions are also embedded in the JWT; refresh from /auth/me on load.
  localStorage.setItem(STORAGE_KEYS.PERMISSIONS, JSON.stringify(state.permissions));
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

export function endSession() {
  state.token = '';
  state.user = null;
  state.permissions = [];
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.PERMISSIONS);
  notify();
}

/** API client: attaches the JWT, normalizes envelopes, handles expiry. */
import { API_BASE, STORAGE_KEYS } from '../config.js';

export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function token() {
  return localStorage.getItem(STORAGE_KEYS.TOKEN) || '';
}

export function clearSessionStorage() {
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.PERMISSIONS);
}

async function request(path, { method = 'GET', body, query, signal } = {}) {
  let url = `${API_BASE}${path}`;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    });
    url += `?${params.toString()}`;
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const jwt = token();
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'same-origin'
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch (e) {
    throw new ApiError(response.status, 'BAD_RESPONSE', 'The server returned an invalid response.');
  }

  if (!response.ok || payload.ok === false) {
    const error = payload.error || {};
    if (response.status === 401 && error.code === 'UNAUTHORIZED') {
      clearSessionStorage();
      window.dispatchEvent(new CustomEvent('cms:unauthorized'));
    }
    throw new ApiError(
      response.status, error.code || 'REQUEST_FAILED',
      error.message || `Request failed (${response.status})`, error.details || []
    );
  }

  return payload.data;
}

export const api = {
  get: (path, query) => request(path, { method: 'GET', query }),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' })
};

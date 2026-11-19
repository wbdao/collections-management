/**
 * API client: attaches the JWT, normalizes envelopes, handles expiry.
 * PHASE 2 / Step 2: single-flight refresh interceptor for 15-minute access tokens.
 */
import { API_BASE } from '../config.js';
import {
  applyTokens, clearSessionStorage, getSessionTokens
} from '../store.js';

export { clearSessionStorage };

export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Codes that mean "this access token is no longer usable". Bad credentials on
// /auth/login are deliberately NOT in this set, so a failed login cannot log
// an existing user out.
const SESSION_ERRORS = new Set([
  'UNAUTHORIZED', 'TOKEN_EXPIRED', 'SESSION_REVOKED',
  'REFRESH_INVALID', 'REFRESH_REUSE'
]);

// These endpoints use either no token at all or a dedicated short-lived MFA
// challenge token; refreshing on a 401 there would only cause loops.
function canRefresh(path) {
  return !/^\/auth\/(refresh|login|mfa)(\/|$)/.test(path);
}

function forceLogout() {
  clearSessionStorage();
  window.dispatchEvent(new CustomEvent('cms:unauthorized'));
}

let refreshInFlight = null;

/** One refresh promise shared by every request that fails 401 at the same time. */
function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { refreshToken } = getSessionTokens();
      if (!refreshToken) throw new ApiError(401, 'REFRESH_INVALID', 'No refresh token available.');

      let response;
      try {
        response = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          credentials: 'same-origin'
        });
      } catch (err) {
        throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
      }

      let payload;
      try {
        payload = await response.json();
      } catch (e) {
        throw new ApiError(response.status, 'BAD_RESPONSE', 'Invalid refresh response.');
      }

      if (!response.ok || payload.ok === false) {
        const error = payload.error || {};
        throw new ApiError(
          response.status, error.code || 'REFRESH_FAILED',
          error.message || 'Session expired.', error.details || []
        );
      }

      // Rotation returns a new refresh token; replace it immediately.
      applyTokens(payload.data || {});
      return payload.data?.accessToken || '';
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function request(path, { method = 'GET', body, query, signal, authToken } = {}, retried = false) {
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
  // authToken is an explicit override for short-lived MFA challenge tokens;
  // it is never persisted by the store.
  const jwt = authToken || getSessionTokens().token;
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

  const error = payload.error || {};
  if (response.status === 401 && SESSION_ERRORS.has(error.code) && jwt) {
    if (!retried && canRefresh(path)) {
      try {
        await refreshAccessToken();
        return request(path, { method, body, query, signal, authToken }, true);
      } catch (refreshError) {
        // Refresh failed (expired/reused/revoked): terminate the local session.
        forceLogout();
        throw new ApiError(
          response.status, error.code || 'UNAUTHORIZED',
          'Your session has expired. Please sign in again.', error.details || []
        );
      }
    }
    forceLogout();
  }

  if (!response.ok || payload.ok === false) {
    throw new ApiError(
      response.status, error.code || 'REQUEST_FAILED',
      error.message || `Request failed (${response.status})`, error.details || []
    );
  }

  return payload.data;
}

/** Multipart upload (R2 attachments). Returns parsed envelope data. */
async function upload(path, formData, retried = false) {
  const url = `${API_BASE}${path}`;
  const jwt = getSessionTokens().token;
  const headers = { Accept: 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: formData, credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
  }

  if (response.status === 401 && jwt && canRefresh(path) && !retried) {
    try {
      await refreshAccessToken();
      return upload(path, formData, true);
    } catch (refreshError) {
      forceLogout();
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired.');
    }
  }

  let payload;
  try { payload = await response.json(); }
  catch (e) { throw new ApiError(response.status, 'BAD_RESPONSE', 'Invalid upload response.'); }
  if (!response.ok || payload.ok === false) {
    const error = payload.error || {};
    throw new ApiError(response.status, error.code || 'UPLOAD_FAILED', error.message || 'Upload failed.');
  }
  return payload.data;
}

/** Authenticated binary download — returns a Blob (R2 buckets are private). */
async function download(path, retried = false) {
  const url = `${API_BASE}${path}`;
  const jwt = getSessionTokens().token;
  const headers = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  let response;
  try {
    response = await fetch(url, { method: 'GET', headers, credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
  }

  if (response.status === 401 && jwt && canRefresh(path) && !retried) {
    try {
      await refreshAccessToken();
      return download(path, true);
    } catch (refreshError) {
      forceLogout();
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired.');
    }
  }

  if (!response.ok) {
    let code = 'DOWNLOAD_FAILED';
    try { code = (await response.json()).error?.code || code; } catch (e) { /* opaque body */ }
    throw new ApiError(response.status, code, 'Unable to download the file.');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const fileName = match ? decodeURIComponent(match[1]) : 'attachment';
  return { blob, fileName };
}

export const api = {
  get: (path, query) => request(path, { method: 'GET', query }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload,
  download
};

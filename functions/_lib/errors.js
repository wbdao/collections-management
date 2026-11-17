/** Normalizes any thrown error into an API-safe shape. */

export function normalizeError(error) {
  const status = Number(error?.status) || (error?.code === 'UNAUTHORIZED' ? 401 : 500);
  const known = new Set([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]);
  return {
    status: known.has(status) ? status : 500,
    code: error?.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    message: status >= 500 && !error?.code
      ? 'An unexpected error occurred'
      : (error?.message || 'Request failed'),
    details: error?.details || []
  };
}

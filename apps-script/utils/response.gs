/** Response envelope used for every Cloudflare ↔ Apps Script call. */

var ResponseUtil = {
  ok: function (requestId, data, meta) {
    return {
      protocol: CONFIG.protocol,
      requestId: requestId,
      ok: true,
      data: data === undefined ? null : data,
      meta: meta || {},
      error: null
    };
  },
  fail: function (requestId, error) {
    return {
      protocol: CONFIG.protocol,
      requestId: requestId,
      ok: false,
      data: null,
      meta: {},
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message || 'Unexpected error',
        details: error.details || []
      }
    };
  }
};

/** Apps Script Web App entry point. Only Cloudflare Functions may call this URL. */

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    protocol: CONFIG.protocol, ok: true, service: 'cms-phase1-adapter', time: Helpers.nowIso()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var requestId = (e && e.parameter && e.parameter.requestId) || 'unknown';
  try {
    var raw = String(e && e.postData && e.postData.contents ? e.postData.contents : '');
    if (!raw) Errors.fail('VALIDATION_ERROR', 'Empty request body');

    var envelope = JSON.parse(raw);
    requestId = envelope.requestId || requestId;
    if (envelope.protocol !== CONFIG.protocol) Errors.fail('BAD_PROTOCOL', 'Unsupported protocol');

    var provided = String(e.parameter.signature || '');
    if (!provided) {
      var header = e.postData.headers || {};
      provided = String(header['X-Signature'] || header['x-signature'] || '');
    }
    var expected = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(raw, CONFIG.sharedSecret)
    ).replace(/=+$/, '');
    if (provided !== expected) Errors.fail('UNAUTHORIZED', 'Invalid request signature');

    var result = Router.handle(envelope);
    return ContentService.createTextOutput(JSON.stringify(
      ResponseUtil.ok(requestId, result.data, result.meta || {})
    )).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var error = Errors.from(err);
    if (error.code !== 'UNAUTHORIZED') {
      try {
        SheetsAdapter.insertRow('integration_errors', {
          error_id: Helpers.id('ERR'), request_id: requestId, action: '', envelope_json: '',
          error_code: error.code, message: error.message, retry_count: 0,
          created_at: Helpers.nowIso(), resolved_at: ''
        });
      } catch (ignored) { /* never mask the original error */ }
    }
    return ContentService.createTextOutput(JSON.stringify(
      ResponseUtil.fail(requestId, error)
    )).setMimeType(ContentService.MimeType.JSON);
  }
}

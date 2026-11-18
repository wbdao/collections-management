/** Apps Script Web App entry point. Only Cloudflare Functions may call this URL. */

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    protocol: CONFIG.protocol, ok: true, service: 'cms-phase1-adapter', time: Helpers.nowIso()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // Query parameters always arrive via e.parameter; custom headers do not
  // survive Google's Web App redirect proxy, so the query param is authoritative.
  var provided = String((e && e.parameter && e.parameter.signature) || '');
  var requestId = String((e && e.parameter && e.parameter.requestId) || 'unknown');
  var raw = String(e && e.postData && e.postData.contents ? e.postData.contents : '');
  try {
    if (!raw) Errors.fail('VALIDATION_ERROR', 'Empty request body');
    var expected = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(raw, CONFIG.sharedSecret)
    ).replace(/=+$/, '');
    if (provided !== expected) Errors.fail('UNAUTHORIZED', 'Invalid request signature');

    var envelope = JSON.parse(raw);
    if (envelope.protocol !== CONFIG.protocol) Errors.fail('BAD_PROTOCOL', 'Unsupported protocol');
    requestId = envelope.requestId || requestId;

    var result = Router.handle(envelope);
    return ContentService.createTextOutput(JSON.stringify(
      ResponseUtil.ok(requestId, result.data, result.meta || {})
    )).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var error = Errors.from(err);
    return ContentService.createTextOutput(JSON.stringify(
      ResponseUtil.fail(requestId, error)
    )).setMimeType(ContentService.MimeType.JSON);
  }
}

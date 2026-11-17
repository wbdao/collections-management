/** Request validation helpers built on the shared schemas. */

import { SCHEMAS, validate } from '../../shared/schemas/index.js';

export function validateBody(name, body) {
  const schema = SCHEMAS[name];
  if (!schema) return body;
  const result = validate(schema, body);
  if (!result.valid) {
    throw Object.assign(new Error('Validation failed'), {
      code: 'VALIDATION_ERROR', status: 400, details: result.errors
    });
  }
  return body;
}

export function queryFromRequest(request) {
  const url = new URL(request.url);
  const query = {};
  url.searchParams.forEach((value, key) => {
    if (['limit', 'offset', 'page'].includes(key)) query[key] = Number(value);
    else if (key === 'descending') query[key] = value === 'true';
    else query[key] = value;
  });
  return query;
}

export function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('A JSON object body is required'), {
      code: 'VALIDATION_ERROR', status: 400
    });
  }
  return body;
}

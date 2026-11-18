/** Signed GAS payloads must be ASCII-only so Apps Script HMAC matches Workers HMAC. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiJson } from '../functions/_lib/gas-client.js';

test('asciiJson escapes non-ASCII but round-trips the original value', () => {
  const value = { query: 'احمد عصام السيد-كهربا', note: 'café ☕' };
  const serialized = asciiJson(value);

  assert.match(serialized, /^[\x00-\x7F]*$/, 'payload must contain ASCII bytes only');
  assert.deepEqual(JSON.parse(serialized), value, 'decoded payload must be unchanged');
});

test('asciiJson leaves ASCII payloads identical to JSON.stringify', () => {
  const value = { action: 'customer.search', payload: { query: 'CUST020208', limit: 3 } };
  assert.equal(asciiJson(value), JSON.stringify(value));
});

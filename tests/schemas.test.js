/** Validation must match the current customer-master based document flow. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS, validate } from '../shared/schemas/index.js';

const valid = (name, body) => validate(SCHEMAS[name], body);

test('collect requires Account and rejects the legacy customer_id-only body', () => {
  assert.equal(valid('collect', { account: '12345', amount_minor: 100 }).valid, true);
  const legacy = valid('collect', { customer_id: '12345', amount_minor: 100 });
  assert.equal(legacy.valid, false);
  assert.ok(legacy.errors.some((e) => e.field === 'account'));
});

test('cheque and guarantee require Account', () => {
  assert.equal(valid('cheque', {
    cheque_number: 'CHQ-1', account: '12345', bank: 'CIB', amount_minor: 100
  }).valid, true);
  assert.equal(valid('cheque', {
    cheque_number: 'CHQ-1', bank: 'CIB', amount_minor: 100
  }).valid, false);
  assert.equal(valid('guarantee', {
    guarantee_number: 'GRT-1', account: '12345', amount_minor: 100
  }).valid, true);
  assert.equal(valid('guarantee', { guarantee_number: 'GRT-1', amount_minor: 100 }).valid, false);
});

test('batch and book schemas no longer require a warehouse master reference', () => {
  const batch = valid('batch', {
    batch_number: 'BAT-1', supplier: 'PrintCo', delivery_date: '2026-01-01',
    serial_from: 1, serial_to: 10
  });
  assert.equal(batch.valid, true, JSON.stringify(batch.errors));
  const book = valid('book', { batch_id: 'BAT-1', serial_from: 1, serial_to: 10 });
  assert.equal(book.valid, true, JSON.stringify(book.errors));
});

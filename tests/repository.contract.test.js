/** Contract checks for the Repository Interface (shared by edge + future D1). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPOSITORY_METHODS, ENTITY } from '../shared/contracts/repository.js';

test('Repository contract exposes all required operations', () => {
  for (const method of [
    'list', 'get', 'insert', 'update', 'transition',
    'aggregate', 'appendLedger', 'withTransaction'
  ]) {
    assert.ok(REPOSITORY_METHODS.includes(method), `missing repository method: ${method}`);
  }
});

test('No local customer/warehouse/department master entities', () => {
  const forbidden = ['CUSTOMERS', 'CUSTOMER_HISTORY', 'WAREHOUSES', 'DEPARTMENTS', 'BRANCHES', 'LOCATIONS'];
  for (const key of forbidden) {
    assert.equal(ENTITY[key], undefined, `${key} must not be a local entity`);
  }
});

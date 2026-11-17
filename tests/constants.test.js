/** Constants must be internally consistent and mirror the approved catalog. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS, ROLE_PERMISSIONS, STATE_MACHINES } from '../shared/constants/enums.js';

test('customer permissions are read-only', () => {
  assert.ok(PERMISSIONS.includes('customers.read'));
  assert.ok(!PERMISSIONS.includes('customers.create'));
  assert.ok(!PERMISSIONS.includes('customers.update'));
});

test('every role permission is defined in the catalog', () => {
  for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of granted) {
      assert.ok(PERMISSIONS.includes(permission), `${role} references undefined permission ${permission}`);
    }
  }
});

test('state machines cover every operational document entity', () => {
  for (const entity of ['book_batches', 'books', 'receipts', 'cheques', 'guarantees']) {
    assert.ok(STATE_MACHINES[entity], `missing state machine: ${entity}`);
  }
});

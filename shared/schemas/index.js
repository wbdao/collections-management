/** Lightweight shared validation schemas (no external dependency). */

function rule(type, options = {}) {
  return { type, ...options };
}

export const SCHEMAS = {
  login: {
    username: rule('string', { required: true, minLength: 1 }),
    password: rule('string', { required: true, minLength: 1 }),
    deviceInfo: rule('string')
  },
  refresh: {
    refreshToken: rule('string', { required: true, minLength: 1 })
  },
  // PHASE 2 / Step 3 — MFA
  mfaEnroll: {
    type: rule('string', { required: true, enum: ['TOTP', 'EMAIL_OTP'] })
  },
  mfaVerify: {
    code: rule('string', { required: true, minLength: 6 }),
    type: rule('string', { enum: ['TOTP', 'EMAIL_OTP', 'RECOVERY'] }),
    mfaToken: rule('string')
  },
  mfaDisable: {
    code: rule('string', { required: true, minLength: 6 }),
    type: rule('string', { enum: ['TOTP', 'EMAIL_OTP', 'RECOVERY'] })
  },
  mfaResend: {},

  // PHASE 2 / Step 7 — approval decisions
  approvalDecision: {
    notes: rule('string'),
    reason: rule('string')
  },

  // PHASE 2 / Step 4 — treasuries
  treasury: {
    treasury_id: rule('string', { required: true, pattern: /^[A-Za-z0-9_-]{2,40}$/ }),
    treasury_name: rule('string', { required: true }),
    treasury_type: rule('string', { required: true, enum: ['BRANCH', 'HQ'] }),
    warehouse: rule('string'),
    status: rule('string', { enum: ['ACTIVE', 'INACTIVE'] })
  },
  treasuryPatch: {
    treasury_name: rule('string'),
    warehouse: rule('string'),
    status: rule('string', { enum: ['ACTIVE', 'INACTIVE'] })
  },
  batch: {
    batch_number: rule('string', { required: true, pattern: /^BAT-[A-Za-z0-9-]+$/ }),
    supplier: rule('string', { required: true }),
    delivery_date: rule('string', { required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    serial_from: rule('integer', { required: true, min: 0 }),
    serial_to: rule('integer', { required: true, min: 0 }),
    expected_quantity: rule('integer', { min: 0 }),
    notes: rule('string')
  },
  // Customer master is external and read-only; there is no create/update body.
  customer: {
    account: rule('string', { required: true })
  },
  book: {
    batch_id: rule('string', { required: true }),
    serial_from: rule('integer', { required: true, min: 0 }),
    serial_to: rule('integer', { required: true, min: 0 }),
    issue_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    notes: rule('string')
  },
  assignment: {
    assigned_to: rule('string', { required: true }),
    assigned_at: rule('string'),
    due_return_at: rule('string'),
    notes: rule('string')
  },
  collect: {
    account: rule('string', { required: true }),
    amount_minor: rule('integer', { required: true, min: 1 }),
    collection_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    payment_method: rule('string', { enum: ['CASH', 'CHEQUE', 'OTHER'] }),
    notes: rule('string')
  },
  deposit: {
    branch_id: rule('string', { required: true }),
    deposit_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    lines: rule('array', { required: true, minLength: 1 }),
    notes: rule('string')
  },
  cheque: {
    cheque_number: rule('string', { required: true }),
    account: rule('string', { required: true }),
    cheque_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    due_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    bank: rule('string', { required: true }),
    amount_minor: rule('integer', { required: true, min: 0 })
  },
  guarantee: {
    guarantee_number: rule('string', { required: true }),
    account: rule('string', { required: true }),
    contract_number: rule('string'),
    amount_minor: rule('integer', { required: true, min: 0 }),
    issue_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    expiry_date: rule('string', { pattern: /^\d{4}-\d{2}-\d{2}$/ })
  },
  transition: {
    toStatus: rule('string', { required: true }),
    bankReference: rule('string'),
    expectedClearDate: rule('string'),
    clearedAt: rule('string'),
    returnReason: rule('string'),
    notes: rule('string')
  },
  movement: {
    documentType: rule('string', { required: true, enum: ['BOOK', 'RECEIPT', 'CHEQUE', 'GUARANTEE'] }),
    documentNumber: rule('string', { required: true }),
    fromLocation: rule('string', { required: true }),
    toLocation: rule('string', { required: true }),
    movementDate: rule('string'),
    performedBy: rule('string'),
    notes: rule('string')
  }
};

export function validate(schema, data) {
  const errors = [];
  const value = data && typeof data === 'object' ? data : {};
  Object.entries(schema || {}).forEach(([field, spec]) => {
    const v = value[field];
    if (v === undefined || v === null || v === '') {
      if (spec.required) errors.push({ field, issue: 'required' });
      return;
    }
    const typeOk =
      spec.type === 'integer' ? Number.isInteger(Number(v)) :
      spec.type === 'number' ? !Number.isNaN(Number(v)) :
      spec.type === 'array' ? Array.isArray(v) :
      spec.type === 'object' ? typeof v === 'object' && !Array.isArray(v) :
      typeof v === spec.type;
    if (!typeOk) {
      errors.push({ field, issue: `expected ${spec.type}` });
      return;
    }
    if (spec.enum && !spec.enum.includes(v)) errors.push({ field, issue: 'invalid enum value' });
    if (spec.min !== undefined && Number(v) < spec.min) errors.push({ field, issue: `minimum ${spec.min}` });
    if (spec.minLength !== undefined && String(v).length < spec.minLength) errors.push({ field, issue: `minLength ${spec.minLength}` });
    if (spec.pattern && !spec.pattern.test(String(v))) errors.push({ field, issue: 'invalid format' });
  });
  return { valid: errors.length === 0, errors };
}

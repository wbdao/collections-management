/** Standard Apps Script error type carrying an API-safe code. */

function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = code;
  this.message = message;
  this.details = details || [];
}

AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

var Errors = {
  /** Throws AppError when condition is falsy; otherwise returns the condition. */
  assert: function (condition, code, message, details) {
    if (!condition) Errors.fail(code || 'VALIDATION_ERROR', message || 'Assertion failed', details);
    return condition;
  },
  fail: function (code, message, details) { throw new AppError(code, message, details); },
  notFound: function (entity, id) {
    Errors.fail('NOT_FOUND', entity + ' not found: ' + id);
  },
  validation: function (message, details) {
    Errors.fail('VALIDATION_ERROR', message, details);
  },
  conflict: function (message) { Errors.fail('CONFLICT', message); },
  forbidden: function (message) { Errors.fail('FORBIDDEN', message); },
  version: function () { Errors.fail('CONFLICT_VERSION', 'Record was modified by another request'); },
  from: function (err) {
    if (err instanceof AppError) return err;
    var wrapped = new AppError('INTERNAL_ERROR', err && err.message ? err.message : 'Unexpected error');
    wrapped.stack = err && err.stack;
    return wrapped;
  }
};

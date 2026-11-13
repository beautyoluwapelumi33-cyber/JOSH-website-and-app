'use strict';

/** Error carrying an HTTP status and a stable machine-readable code. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new ApiError(400, code, message, details);
const unauthorized = (message = 'Sign in required.') => new ApiError(401, 'unauthorized', message);
const forbidden = (message = 'Administrator access required.') => new ApiError(403, 'forbidden', message);
const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);
const conflict = (code, message, details) => new ApiError(409, code, message, details);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };

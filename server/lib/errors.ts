import type { ErrorRequestHandler } from 'express';

/**
 * API errors follow one shape, so clients can handle them in one place:
 *   { "error": { "type": "card_error", "code": "card_declined", "message": "…" } }
 */
export type ErrorType =
  | 'invalid_request_error' // bad input from the merchant/client
  | 'authentication_error' // missing/wrong API key
  | 'card_error' // the card was declined or is invalid
  | 'idempotency_error' // same Idempotency-Key reused with different parameters
  | 'rate_limit_error'
  | 'api_error'; // our fault

export class ApiError extends Error {
  status: number;
  type: ErrorType;
  code: string;
  param?: string;

  constructor(status: number, type: ErrorType, code: string, message: string, param?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }

  toJSON() {
    return {
      error: { type: this.type, code: this.code, message: this.message, ...(this.param && { param: this.param }) },
    };
  }
}

export const badRequest = (code: string, message: string, param?: string) =>
  new ApiError(400, 'invalid_request_error', code, message, param);

export const notFound = (what: string) =>
  new ApiError(404, 'invalid_request_error', 'resource_missing', `No such ${what}`);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json(badRequest('invalid_json', 'Request body is not valid JSON').toJSON());
    return;
  }
  console.error(err);
  res.status(500).json(new ApiError(500, 'api_error', 'internal_error', 'Something went wrong on our side').toJSON());
};

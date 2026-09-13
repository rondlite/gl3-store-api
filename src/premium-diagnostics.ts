export class PremiumPriceConfigurationError extends Error {
  constructor(readonly invalidFields: string[]) {
    super('Premium requires inclusive EUR prices: 49 annually plus 20 on the first invoice only');
  }
}

export class PurchaseEmailError extends Error {
  constructor(readonly statusCode: number) { super('purchase_email_failed'); }
}

const codes: Record<string, string> = {
  '42P01': 'database_table_missing', '42703': 'database_column_missing',
  '42501': 'database_permission_denied', '28P01': 'database_authentication_failed',
  '25P02': 'database_transaction_aborted', '53300': 'database_connections_exhausted',
  ECONNREFUSED: 'connection_refused', ECONNRESET: 'connection_reset',
  ETIMEDOUT: 'connection_timeout', ENOTFOUND: 'dns_failed', EAI_AGAIN: 'dns_temporary_failure',
  resource_missing: 'stripe_resource_missing', api_key_expired: 'stripe_key_expired',
};
const types = new Set(['StripeAuthenticationError', 'StripePermissionError', 'StripeInvalidRequestError',
  'StripeAPIError', 'StripeConnectionError', 'StripeRateLimitError', 'TypeError', 'TimeoutError', 'AbortError']);

/** Never serialize upstream messages, SQL details, request bodies or credentials. */
export function premiumErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof PremiumPriceConfigurationError) {
    return { reason: 'invalid_premium_prices', invalidFields: error.invalidFields };
  }
  if (error instanceof PurchaseEmailError) return { reason: 'resend_http_error', statusCode: error.statusCode };
  if (!error || typeof error !== 'object') return { reason: 'unknown_error' };
  const err = error as Record<string, unknown>;
  const fields: Record<string, unknown> = { reason: 'unexpected_error' };
  if (typeof err.code === 'string' && Object.hasOwn(codes, err.code)) {
    fields.code = err.code;
    fields.reason = codes[err.code];
  } else if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
    fields.code = err.code;
    fields.reason = 'database_error';
  }
  const type = err.type ?? err.name;
  if (typeof type === 'string' && types.has(type)) fields.errorType = type;
  if (typeof err.statusCode === 'number' && Number.isInteger(err.statusCode) && err.statusCode >= 100 && err.statusCode <= 599) {
    fields.statusCode = err.statusCode;
  }
  if (typeof err.requestId === 'string' && /^req_[A-Za-z0-9]{1,100}$/.test(err.requestId)) fields.requestId = err.requestId;
  // fetch wraps network failures in a TypeError with a system error cause.
  if (err.cause && typeof err.cause === 'object') {
    const code = (err.cause as Record<string, unknown>).code;
    if (typeof code === 'string' && Object.hasOwn(codes, code)) fields.causeCode = code;
  }
  return fields;
}

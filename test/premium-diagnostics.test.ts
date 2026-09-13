import { describe, expect, it, vi } from 'vitest';
import { premiumErrorFields, PremiumPriceConfigurationError, PurchaseEmailError } from '../src/premium-diagnostics.js';
import { premiumRoutes } from '../src/premium-routes.js';
import { startPurchaseMail } from '../src/premium-mail.js';
import { silentLogger } from '../src/log.js';
import type { Premium } from '../src/premium.js';
import type { Db } from '../src/db.js';

describe('safe Premium diagnostics', () => {
  it('keeps Stripe authentication context without credentials or buyer information', () => {
    const error = Object.assign(new Error('Invalid API Key provided: sk_live_private buyer@example.com'), {
      type: 'StripeAuthenticationError', statusCode: 401, requestId: 'req_123abc',
      raw: { message: 'sk_live_private' }, detail: 'buyer@example.com',
    });
    expect(premiumErrorFields(error)).toEqual({ reason: 'unexpected_error',
      errorType: 'StripeAuthenticationError', statusCode: 401, requestId: 'req_123abc' });
    expect(premiumErrorFields({ code: 'sk_live_private', type: 'buyer@example.com', requestId: 'secret' }))
      .toEqual({ reason: 'unexpected_error' });
  });

  it('identifies missing tables, permissions, Resend status and fetch connection failures', () => {
    expect(premiumErrorFields({ code: '42P01', message: 'private SQL' }))
      .toEqual({ reason: 'database_table_missing', code: '42P01' });
    expect(premiumErrorFields({ code: '42501' }))
      .toEqual({ reason: 'database_permission_denied', code: '42501' });
    expect(premiumErrorFields(new PurchaseEmailError(403)))
      .toEqual({ reason: 'resend_http_error', statusCode: 403 });
    expect(premiumErrorFields(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })))
      .toMatchObject({ errorType: 'TypeError', causeCode: 'ECONNREFUSED' });
  });

  it('logs the failing price settings while keeping the HTTP error opaque', async () => {
    const logger = { ...silentLogger(), error: vi.fn() };
    const premium = { price: async () => { throw new PremiumPriceConfigurationError(['annual.tax_behavior']); } };
    const response = await premiumRoutes(premium as unknown as Premium, logger).request('/price');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'premium_unavailable' });
    expect(logger.error).toHaveBeenCalledWith('premium operation failed', {
      path: '/price', reason: 'invalid_premium_prices', invalidFields: ['annual.tax_behavior'],
    });
  });

  it('logs a database connection failure from the email worker', async () => {
    const db = { connect: vi.fn().mockRejectedValue(Object.assign(new Error('private database details'), { code: '42501' })) };
    const logger = { ...silentLogger(), error: vi.fn() };
    const send = vi.fn();
    const stop = startPurchaseMail(db as unknown as Db, Buffer.alloc(32), send, logger);
    await stop();
    expect(logger.error).toHaveBeenCalledWith('purchase email worker failed', {
      reason: 'database_permission_denied', code: '42501',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

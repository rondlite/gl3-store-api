import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createPayments, PREMIUM_TERMS } from '../src/payments.js';
import { createResendMailer } from '../src/premium-mail.js';
import { loadEnv } from '../src/env.js';

const config = { secretKey: 'sk_test_fake', webhookSecret: 'whsec_test', priceId: 'price_annual',
  firstYearPriceId: 'price_initial', portalConfigurationId: 'bpc_test', origin: 'https://gl3.dev' };
function harness() {
  const prices = {
    price_annual: { id: 'price_annual', active: true, currency: 'eur', unit_amount: 4900, tax_behavior: 'inclusive', recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } },
    price_initial: { id: 'price_initial', active: true, type: 'one_time', currency: 'eur', unit_amount: 2000, tax_behavior: 'inclusive' },
  };
  const sdk = {
    prices: { retrieve: vi.fn(async (id: keyof typeof prices) => prices[id]) },
    customers: { create: vi.fn(async () => ({ id: 'cus_test' })) },
    checkout: { sessions: { create: vi.fn(async () => ({ id: 'cs_test', mode: 'subscription', url: 'https://checkout.stripe.com/test' })) } },
    billingPortal: { configurations: { retrieve: vi.fn(async () => ({ active: true, features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'at_period_end' } } })) },
      sessions: { create: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/test' })) } },
    webhooks: Stripe.webhooks,
  };
  return { sdk, prices, payments: createPayments(config, sdk as unknown as Stripe) };
}
afterEach(() => vi.unstubAllGlobals());

describe('annual Stripe adapter (no database or network)', () => {
  it('validates the exact annual VAT-inclusive price contract', async () => {
    const { payments } = harness();
    expect(await payments.price()).toMatchObject(PREMIUM_TERMS);
  });
  it.each(['exclusive', 'unspecified'])('rejects %s tax behaviour', async behavior => {
    const { payments, prices } = harness();
    prices.price_annual.tax_behavior = behavior;
    await expect(payments.price()).rejects.toThrow('inclusive EUR');
  });
  it('rejects an incorrect renewal or first-year price', async () => {
    const { payments, prices } = harness();
    prices.price_annual.unit_amount = 6900;
    await expect(payments.price()).rejects.toThrow();
    prices.price_annual.unit_amount = 4900; prices.price_initial.unit_amount = 6900;
    await expect(payments.price()).rejects.toThrow();
  });
  it('charges the first-year supplement only on initial checkout and always uses annual billing', async () => {
    const { payments, sdk } = harness();
    const order = { id: 'order1', priceId: 'price_annual', firstYearPriceId: 'price_initial', customerId: 'cus_test', createdAt: new Date() };
    await payments.create(order);
    expect(sdk.checkout.sessions.create).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'subscription', customer: 'cus_test', automatic_tax: { enabled: true }, adaptive_pricing: { enabled: false },
      line_items: [{ price: 'price_annual', quantity: 1 }, { price: 'price_initial', quantity: 1 }],
    }), { idempotencyKey: 'premium-order1' });
    await payments.create({ ...order, id: 'returning', firstYearPriceId: null });
    expect(sdk.checkout.sessions.create).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'subscription', line_items: [{ price: 'price_annual', quantity: 1 }],
    }), { idempotencyKey: 'premium-returning' });
  });
  it('pins the customer and rejects portal configurations that remove paid time', async () => {
    const { payments, sdk } = harness();
    await payments.portal('cus_test');
    expect(sdk.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_test', configuration: 'bpc_test', return_url: 'https://gl3.dev/account.html' });
    sdk.billingPortal.configurations.retrieve.mockResolvedValueOnce({ active: true,
      features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: 'immediately' } } });
    await expect(payments.portal('cus_test')).rejects.toThrow('Invalid Premium portal');
  });
  it('verifies exact webhook bytes and routes paid invoices; failed invoices never grant access', () => {
    const { payments } = harness();
    for (const type of ['invoice.paid', 'invoice.payment_failed']) {
      const raw = JSON.stringify({ type, data: { object: { id: 'in_test' } } });
      const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: config.webhookSecret });
      expect(payments.event(raw, signature)).toEqual(type === 'invoice.paid' ? { type: 'invoice', invoiceId: 'in_test' } : { type: 'ignore' });
      expect(() => payments.event(raw + ' ', signature)).toThrow();
    }
  });
});

it('sends annual terms and Discord support through Resend with invoice idempotency', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const send = createResendMailer({ apiKey: 'resend-test', from: 'premium@gl3.dev', origin: 'https://gl3.dev' });
  const mail = { invoiceId: 'in_test', orderId: 'order_test', email: 'buyer@example.com', username: 'buyer', token: null,
    amount: 6900, paidUntil: '2027-09-13T00:00:00.000Z', renewalAmount: 4900 };
  await send(mail);
  const [url, request] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.resend.com/emails');
  expect(request.headers['Idempotency-Key']).toBe('premium-invoice/in_test');
  const text = JSON.parse(request.body).text;
  expect(text).toContain('€69.00'); expect(text).toContain('€49.00');
  expect(text).toContain('https://discord.gg/6U8ezKE8T');
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 429 }));
  await expect(send(mail)).rejects.toThrow('purchase_email_failed');
});

it('requires complete billing and Resend configuration together', () => {
  const base = { DATABASE_URL: 'postgres:///unused', INTERNAL_API_KEY: 'k'.repeat(32) };
  expect(() => loadEnv(base)).not.toThrow();
  expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_test' })).toThrow('STRIPE_FIRST_YEAR_PRICE_ID');
  expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PREMIUM_PRICE_ID: 'price_annual', STRIPE_FIRST_YEAR_PRICE_ID: 'price_initial', STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_test',
    PREMIUM_TOKEN_KEY: 'a'.repeat(64), RESEND_API_KEY: 're_test', PREMIUM_EMAIL_FROM: 'premium@gl3.dev' })).not.toThrow();
});

it('verifies paid invoice lines and customer identity from Stripe instead of event metadata', async () => {
  const invoice = { id: 'in_paid', parent: { subscription_details: { subscription: 'sub_paid' } },
    customer: 'cus_paid', status: 'paid', amount_paid: 6900, total: 6900, billing_reason: 'subscription_create', currency: 'eur' };
  const recurring = { quantity: 1, pricing: { price_details: { price: 'price_annual' } },
    parent: { type: 'subscription_item_details', subscription_item_details: { proration: false } }, period: { start: 1800000000, end: 1831536000 } };
  const sdk = {
    invoices: { retrieve: vi.fn(async () => invoice), listLineItems: vi.fn(async () => ({ has_more: false,
      data: [recurring, { ...recurring, parent: { type: 'invoice_item_details', subscription_item_details: null }, pricing: { price_details: { price: 'price_initial' } } }] })) },
    subscriptions: { retrieve: vi.fn(async () => ({ metadata: { premium_order_id: 'saved_order' } })) },
    invoicePayments: { list: vi.fn(async () => ({ data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_paid' } }] })) },
  };
  const payments = createPayments(config, sdk as unknown as Stripe);
  expect(await payments.invoice('in_paid')).toMatchObject({ paid: true, orderId: 'saved_order',
    customerId: 'cus_paid', subscriptionId: 'sub_paid', prices: ['price_annual', 'price_initial'],
    amount: 6900, periodStart: 1800000000, periodEnd: 1831536000, paymentIntent: 'pi_paid' });
  recurring.parent.subscription_item_details.proration = true;
  expect((await payments.invoice('in_paid'))?.paid).toBe(false);
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupHarness, INTERNAL_API_KEY } from './helpers.js';
import { createApp } from '../src/app.js';
import { createPremium } from '../src/premium.js';
import { createPayments, PREMIUM_TERMS, type PaidInvoice, type Checkout, type Payments } from '../src/payments.js';
import { deliverPurchaseMail, createResendMailer } from '../src/premium-mail.js';
import { silentLogger } from '../src/log.js';
import { authenticate, authorizePackage, createUser, createTokenForUser, grantEntitlement } from '../src/service.js';
import { hashToken } from '../src/ids.js';
import Stripe from 'stripe';

const h = setupHarness();
const key = Buffer.alloc(32, 7);
const proof = { email: 'buyer@example.com', orderId: 'a'.repeat(48), claimSecret: 'b'.repeat(64) };
let checkout: Checkout;
let invoice: PaidInvoice;
let subscriptionStatus: string;
let payments: Payments;
let premium: ReturnType<typeof createPremium>;
beforeEach(async () => {
  await h.db.query('truncate premium_invoices, premium_orders, premium_buyers, premium_refunds');
  subscriptionStatus = 'active';
  checkout = { id: 'cs_test_premium', orderId: proof.orderId, status: 'open',
    invoiceId: 'in_initial', subscriptionId: 'sub_premium', customerId: 'cus_premium',
    url: 'https://checkout.stripe.com/c/pay/test' };
  invoice = { id: 'in_initial', orderId: proof.orderId, subscriptionId: 'sub_premium', customerId: 'cus_premium',
    paymentIntent: 'pi_premium', paid: false, initial: true, amount: 6900, currency: 'eur',
    prices: ['price_premium', 'price_first_year'], periodStart: Math.floor(Date.now() / 1000) - 60,
    periodEnd: Math.floor(Date.now() / 1000) + 365 * 86400 };
  payments = {
    price: vi.fn(async () => ({ ...PREMIUM_TERMS, id: 'price_premium', firstYearPriceId: 'price_first_year' })),
    customer: vi.fn(async () => 'cus_premium'),
    create: vi.fn(async () => ({ ...checkout })), retrieve: vi.fn(async () => ({ ...checkout })),
    invoice: vi.fn(async () => ({ ...invoice })),
    subscription: vi.fn(async () => ({ id: 'sub_premium', orderId: proof.orderId, customerId: 'cus_premium',
      status: subscriptionStatus, cancelAtPeriodEnd: false, periodEnd: invoice.periodEnd })),
    portal: vi.fn(async () => 'https://billing.stripe.com/p/session/test'),
    event: vi.fn(() => ({ type: 'checkout' as const, sessionId: checkout.id })),
  };
  premium = createPremium({ db: h.db, payments, encryptionKey: key });
});
async function paid() {
  await premium.start(proof);
  invoice.paid = true; checkout.status = 'complete';
  await premium.fulfill(checkout.id);
}
async function userId() { return (await h.db.query('select user_id from premium_orders where id = $1', [proof.orderId])).rows[0].user_id as string; }

describe('durable premium checkout', () => {
  it('reuses an order/session for retries and never saves the browser claim secret', async () => {
    const first = await premium.start(proof);
    expect(await premium.start(proof)).toEqual(first);
    expect(payments.create).toHaveBeenCalledTimes(1);
    const order = (await h.db.query('select * from premium_orders')).rows[0];
    expect(order.claim_hash).toEqual(hashToken(proof.claimSecret));
    expect(JSON.stringify(order)).not.toContain(proof.claimSecret);
  });
  it('rejects a different browser proof before contacting Stripe', async () => {
    await premium.start(proof);
    await expect(premium.start({ ...proof, claimSecret: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'order_not_found' });
    await expect(premium.claim({ ...proof, claimSecret: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'order_not_found' });
    expect(payments.retrieve).not.toHaveBeenCalled();
  });
  it('does not grant access for unpaid or mismatched payments', async () => {
    await premium.start(proof);
    await premium.fulfill(checkout.id);
    expect((await h.db.query('select * from users')).rows).toHaveLength(0);
    invoice.paid = true; invoice.prices = ['price_other'];
    await expect(premium.fulfill(checkout.id)).rejects.toMatchObject({ code: 'payment_mismatch' });
    invoice.prices = ['price_premium', 'price_first_year']; invoice.amount = 1;
    await expect(premium.fulfill(checkout.id)).rejects.toMatchObject({ code: 'payment_mismatch' });
    expect((await h.db.query('select * from tokens')).rows).toHaveLength(0);
  });
  it('provisions exactly once across concurrent webhooks and status checks', async () => {
    await premium.start(proof); invoice.paid = true; checkout.status = 'complete';
    await Promise.all([premium.fulfill(checkout.id), premium.fulfill(checkout.id), premium.status(proof)]);
    expect((await h.db.query('select * from users')).rows).toHaveLength(1);
    expect((await h.db.query('select * from tokens')).rows).toHaveLength(1);
    expect(await authorizePackage(h.db, { userId: await userId(), package: '@gl3-plugins/market', tarball: true })).toBe('ok');
    const credentials = await premium.claim(proof);
    expect(await authenticate(h.db, credentials)).toMatchObject({ username: credentials.username });
    expect(JSON.stringify((await h.db.query('select * from premium_orders')).rows)).not.toContain(credentials.token);
    await expect(premium.claim(proof)).rejects.toMatchObject({ code: 'credentials_already_delivered' });
  });
  it('does not disclose credentials for an existing email or grant staff roles', async () => {
    const user = await createUser(h.db, { username: 'oldbuyer', email: 'BUYER@example.com' });
    await expect(premium.start(proof)).rejects.toMatchObject({ code: 'sign_in_required' });
    const original = await createTokenForUser(h.db, { userId: user.userId });
    await premium.start({ ...proof, auth: { username: user.username, token: original.token } });
    invoice.paid = true; await premium.fulfill(checkout.id);
    expect(await userId()).toBe(user.userId);
    expect((await h.db.query('select * from tokens')).rows).toHaveLength(1);
    expect((await h.db.query('select * from user_roles')).rows).toHaveLength(0);
    expect(await premium.status(proof)).toMatchObject({ state: 'ready', canClaim: false });
    await expect(premium.claim(proof)).rejects.toMatchObject({ code: 'credentials_already_delivered' });
  });
  it('honours a full refund even if it arrives before completion', async () => {
    await premium.start(proof);
    await premium.refund(invoice.paymentIntent!);
    invoice.paid = true;
    await premium.fulfill(checkout.id);
    expect(await premium.status(proof)).toEqual({ state: 'refunded' });
    expect((await h.db.query('select * from entitlements')).rows).toHaveLength(0);
  });
  it('revokes a refunded licence and ignores replayed completion', async () => {
    await paid();
    const id = await userId();
    await premium.refund(invoice.paymentIntent!);
    await premium.fulfill(checkout.id);
    expect(await authorizePackage(h.db, { userId: id, package: '@gl3-plugins/market', tarball: true })).toBe('not_entitled');
    await expect(premium.claim(proof)).rejects.toMatchObject({ code: 'not_ready' });
  });
  it('preserves independent manual access after a refund', async () => {
    const user = await createUser(h.db, { username: 'manualbuyer', email: proof.email });
    await grantEntitlement(h.db, { userId: user.userId, package: '@gl3-plugins/*', source: 'manual' });
    const original = await createTokenForUser(h.db, { userId: user.userId });
    await premium.start({ ...proof, auth: { username: user.username, token: original.token } });
    invoice.paid = true; await premium.fulfill(checkout.id); await premium.refund(invoice.paymentIntent!);
    expect(await authorizePackage(h.db, { userId: user.userId, package: '@gl3-plugins/market', tarball: true })).toBe('ok');
  });
});

describe('Resend outbox', () => {
  it('retries failed delivery with the same credentials after browser claim', async () => {
    await paid();
    const credentials = await premium.claim(proof);
    const send = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    await deliverPurchaseMail(h.db, key, send, silentLogger());
    expect(await premium.status(proof)).toMatchObject({ emailSent: false });
    await h.db.query('update premium_invoices set email_retry_at = now()');
    await deliverPurchaseMail(h.db, key, send, silentLogger());
    expect(send.mock.calls[0]![0]).toMatchObject(credentials);
    expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
    expect(await premium.status(proof)).toMatchObject({ emailSent: true });
    expect((await h.db.query('select token_ciphertext from premium_orders')).rows[0].token_ciphertext).toBeNull();
  });
  it('serialises concurrent delivery workers and retains the on-screen claim', async () => {
    await paid();
    const send = vi.fn(async (_mail: import('../src/premium-mail.js').PurchaseMail) => {});
    await Promise.all([deliverPurchaseMail(h.db, key, send, silentLogger()), deliverPurchaseMail(h.db, key, send, silentLogger())]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await premium.status(proof)).toMatchObject({ canClaim: true });
    const claimed = await premium.claim(proof);
    expect(send.mock.calls[0]?.[0]).toMatchObject(claimed);
  });

});

it('requires internal auth and validates signed raw Stripe webhooks', async () => {
  const realPayments = createPayments({ secretKey: 'sk_test_fake', webhookSecret: 'whsec_test', priceId: 'price_premium', firstYearPriceId: 'price_first_year', portalConfigurationId: 'bpc_test', origin: 'https://gl3.dev' });
  const body = JSON.stringify({ id: 'evt_test', type: 'customer.created', data: { object: {} } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_test' });
  const app = createApp({ db: h.db, internalApiKey: INTERNAL_API_KEY, premium: { ...premium, event: realPayments.event } });
  expect((await app.request('/v1/premium/price')).status).toBe(401);
  const headers = { authorization: `Bearer ${INTERNAL_API_KEY}`, 'stripe-signature': signature };
  expect((await app.request('/v1/premium/webhook', { method: 'POST', headers, body })).status).toBe(200);
  expect((await app.request('/v1/premium/webhook', { method: 'POST', headers, body: body + ' ' })).status).toBe(400);
});

it('atomically replaces only the authenticated user’s token and refuses replay', async () => {
  const user = await createUser(h.db, { username: 'buyer', email: 'buyer@example.com' });
  const old = await createTokenForUser(h.db, { userId: user.userId });
  const other = await createTokenForUser(h.db, { userId: user.userId });
  const body = JSON.stringify({ username: user.username, token: old.token });
  const response = await h.call('/v1/account/rotate-token', { method: 'POST', body });
  expect(response.status).toBe(200);
  const replacement = await response.json();
  expect(await authenticate(h.db, replacement)).not.toBeNull();
  expect(await authenticate(h.db, { username: user.username, token: old.token })).toBeNull();
  expect(await authenticate(h.db, { username: user.username, token: other.token })).not.toBeNull();
  expect((await h.call('/v1/account/rotate-token', { method: 'POST', body })).status).toBe(401);
});

it('sets expiry from paid invoices and does not extend it on an unpaid renewal', async () => {
  await paid();
  const credentials = await premium.claim(proof);
  const until = (await premium.billing(credentials)).paidUntil;
  invoice = { ...invoice, id: 'in_renewal', paymentIntent: 'pi_renewal', paid: false,
    initial: false, amount: 4900, prices: ['price_premium'], periodStart: invoice.periodEnd,
    periodEnd: invoice.periodEnd + 365 * 86400 };
  await premium.paidInvoice(invoice.id);
  expect((await premium.billing(credentials)).paidUntil).toBe(until);
  invoice.paid = true;
  await Promise.all([premium.paidInvoice(invoice.id), premium.paidInvoice(invoice.id)]);
  expect((await premium.billing(credentials)).paidUntil).toBe(new Date(invoice.periodEnd * 1000).toISOString());
  expect((await h.db.query('select * from premium_invoices')).rows).toHaveLength(2);
});

it('returns at €49 after a lapse and refuses duplicate live subscriptions', async () => {
  await paid();
  const credentials = await premium.claim(proof);
  const returning = { ...proof, orderId: 'c'.repeat(48), auth: credentials };
  await expect(premium.start(returning)).rejects.toMatchObject({ code: 'subscription_exists' });
  subscriptionStatus = 'canceled';
  checkout = { ...checkout, id: 'cs_returning', orderId: returning.orderId,
    status: 'open', invoiceId: 'in_returning', subscriptionId: 'sub_returning' };
  await premium.start(returning);
  expect(payments.create).toHaveBeenLastCalledWith(expect.objectContaining({
    id: returning.orderId, priceId: 'price_premium', firstYearPriceId: null,
  }));
  const order = (await h.db.query('select amount from premium_orders where id = $1', [returning.orderId])).rows[0];
  expect(order.amount).toBe(4900);
  invoice = { ...invoice, id: 'in_returning', orderId: returning.orderId,
    subscriptionId: 'sub_returning', paymentIntent: 'pi_returning', amount: 4900,
    prices: ['price_premium'], periodStart: invoice.periodEnd, periodEnd: invoice.periodEnd + 365 * 86400 };
  await premium.fulfill(checkout.id);
  expect((await premium.billing(credentials)).paidUntil).toBe(new Date(invoice.periodEnd * 1000).toISOString());
  expect((await h.db.query('select * from tokens')).rows).toHaveLength(1);
});

it('lapsed access denies downloads while the buyer can still sign in and renew', async () => {
  invoice.periodStart -= 2 * 365 * 86400;
  invoice.periodEnd = Math.floor(Date.now() / 1000) - 60;
  await paid();
  const credentials = await premium.claim(proof);
  expect(await authorizePackage(h.db, { userId: await userId(), package: '@gl3-plugins/market', tarball: true })).toBe('not_entitled');
  expect(await authenticate(h.db, credentials)).not.toBeNull();
  expect((await premium.billing(credentials)).renewalEligible).toBe(true);
});

import { timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { Db } from './db.js';
import { hashToken, newId, newToken } from './ids.js';
import type { Payments } from './payments.js';
import { authenticate } from './service.js';
import { seal, unseal } from './secrets.js';

export class PremiumError extends Error {
  constructor(public code: string, public status: 400 | 401 | 404 | 409 | 410 | 503) { super(code); }
}
export type Credentials = { username: string; token: string };
export type Proof = { orderId: string; claimSecret: string };
export type Order = {
  id: string; claim_hash: Buffer; buyer_id: string; price_id: string; first_year_price_id: string | null;
  initial_year: boolean; amount: number; currency: string; subscription_id: string | null;
  session_id: string | null; payment_intent: string | null; user_id: string | null;
  email: string | null; token_ciphertext: string | null; created_at: Date;
  fulfilled_at: Date | null; claimed_at: Date | null; refunded_at: Date | null;
  email_sent_at: Date | null; email_attempts: number;
};
type Buyer = { id: string; email: string; user_id: string | null; stripe_customer_id: string | null;
  renewal_price_id: string; renewal_amount: number; first_paid_at: Date | null };

// Invoice history, not subscription status, determines paid access. No event
// timer is needed to expire it: registry authorisation already checks expires_at.
async function reconcile(client: pg.PoolClient, buyer: Buyer) {
  if (!buyer.user_id) return;
  const expiry = (await client.query<{ paid_until: Date | null }>(`select max(i.period_end) as paid_until
    from premium_invoices i join premium_orders o on o.id = i.order_id
    where o.buyer_id = $1 and i.refunded_at is null`, [buyer.id])).rows[0]!.paid_until;
  await client.query(`insert into entitlements (user_id, package, access, source, expires_at, revoked_at)
    values ($1, '@gl3-plugins/*', 'download', 'stripe-subscription', $2, case when $2::timestamptz is null then now() else null end)
    on conflict (user_id, package) do update set access = excluded.access,
      source = excluded.source, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at
    where entitlements.source = 'stripe-subscription' or entitlements.revoked_at is not null
      or entitlements.access <> 'download'
      or (entitlements.expires_at is not null and entitlements.expires_at < excluded.expires_at)`, [buyer.user_id, expiry]);
}

export function createPremium({ db, payments, encryptionKey }: { db: Db; payments: Payments; encryptionKey: Buffer }) {
  function checkProof(order: Order | undefined, proof: Proof): asserts order is Order {
    if (!order || !timingSafeEqual(order.claim_hash, hashToken(proof.claimSecret))) throw new PremiumError('order_not_found', 404);
  }
  async function getOrder(proof: Proof) {
    const order = (await db.query<Order>('select * from premium_orders where id = $1', [proof.orderId])).rows[0];
    checkProof(order, proof); return order;
  }
  async function authenticated(auth: Credentials) {
    const user = await authenticate(db, auth);
    if (!user) throw new PremiumError('invalid_credentials', 401);
    return user;
  }

  async function start(input: Proof & { email?: string; auth?: Credentials }) {
    const prior = (await db.query<Order>('select * from premium_orders where id = $1', [input.orderId])).rows[0];
    if (prior) {
      checkProof(prior, input);
      if (prior.fulfilled_at && !prior.refunded_at) return { completed: true };
    }
    const auth = input.auth ? await authenticated(input.auth) : null;
    const email = auth ? (await db.query<{ email: string }>('select email from users where id = $1', [auth.userId])).rows[0]!.email.toLowerCase()
      : input.email?.toLowerCase();
    if (!email) throw new PremiumError('email_required', 400);
    const price = await payments.price();
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(`insert into premium_buyers (id, email, renewal_price_id, renewal_amount)
        values ($1, $2, $3, $4) on conflict (email) do nothing`, [newId('buyer'), email, price.id, price.renewalAmount]);
      const buyer = (await client.query<Buyer>('select * from premium_buyers where email = $1 for update', [email])).rows[0]!;
      const knownUser = (await client.query<{ id: string }>('select id from users where lower(email) = $1', [email])).rows[0];
      if ((buyer.user_id || knownUser) && auth?.userId !== (buyer.user_id ?? knownUser?.id)) {
        throw new PremiumError('sign_in_required', 409);
      }
      // One buyer, one pending checkout or live subscription. Query Stripe for
      // current cancellation state so delayed webhooks cannot permit duplicates.
      const previous = (await client.query<Order>(`select * from premium_orders where buyer_id = $1
        order by created_at desc`, [buyer.id])).rows;
      for (const order of previous) {
        if (order.subscription_id) {
          const subscription = await payments.subscription(order.subscription_id);
          if (!['canceled', 'incomplete_expired'].includes(subscription.status)) throw new PremiumError('subscription_exists', 409);
        }
        if (order.id !== input.orderId && !order.subscription_id && Date.now() - order.created_at.getTime() < 24 * 3600_000) {
          throw new PremiumError('checkout_in_progress', 409);
        }
      }
      let order = (await client.query<Order>('select * from premium_orders where id = $1', [input.orderId])).rows[0];
      if (!order) {
        // A refunded first invoice alone does not establish renewal eligibility.
        const returning = (await client.query(`select 1 from premium_invoices i join premium_orders o on o.id = i.order_id
          where o.buyer_id = $1 and i.refunded_at is null limit 1`, [buyer.id])).rowCount! > 0;
        await client.query(`insert into premium_orders (id, claim_hash, buyer_id, price_id, first_year_price_id,
          initial_year, amount, currency, email) values ($1,$2,$3,$4,$5,$6,$7,'eur',$8)`,
        [input.orderId, hashToken(input.claimSecret), buyer.id, buyer.renewal_price_id,
          returning ? null : price.firstYearPriceId, !returning, returning ? buyer.renewal_amount : price.firstYearAmount, email]);
        order = (await client.query<Order>('select * from premium_orders where id = $1', [input.orderId])).rows[0]!;
      }
      checkProof(order, input);
      if (order.buyer_id !== buyer.id) throw new PremiumError('order_not_found', 404);
      if (Date.now() - order.created_at.getTime() > 23 * 3600_000) throw new PremiumError('checkout_expired', 410);
      if (!buyer.stripe_customer_id) {
        buyer.stripe_customer_id = await payments.customer(buyer.id, buyer.email);
        await client.query('update premium_buyers set stripe_customer_id = $2 where id = $1', [buyer.id, buyer.stripe_customer_id]);
      }
      // Commit the order before creating checkout. A timeout must not lose the
      // parameters associated with Stripe's idempotency key.
      await client.query('commit');
      const session = order.session_id ? await payments.retrieve(order.session_id) : await payments.create({
        id: order.id, priceId: order.price_id, firstYearPriceId: order.first_year_price_id,
        customerId: buyer.stripe_customer_id, createdAt: order.created_at,
      });
      await client.query('update premium_orders set session_id = $2 where id = $1 and session_id is null', [order.id, session.id]);
      if (session.status === 'complete') return { completed: true };
      if (session.status === 'expired') throw new PremiumError('checkout_expired', 410);
      if (!session.url || new URL(session.url).origin !== 'https://checkout.stripe.com') throw new PremiumError('checkout_unavailable', 503);
      return { url: session.url };
    } catch (err) { await client.query('rollback'); throw err; }
    finally { client.release(); }
  }

  async function paidInvoice(invoiceId: string) {
    const invoice = await payments.invoice(invoiceId);
    if (!invoice?.paid || !invoice.orderId || !invoice.paymentIntent) return;
    const client = await db.connect();
    try {
      await client.query('begin');
      const hint = (await client.query<Order>('select * from premium_orders where id = $1', [invoice.orderId])).rows[0];
      if (!hint?.buyer_id) { await client.query('commit'); return; }
      const buyer = (await client.query<Buyer>('select * from premium_buyers where id = $1 for update', [hint.buyer_id])).rows[0]!;
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`payment:${invoice.paymentIntent}`]);
      const order = (await client.query<Order>('select * from premium_orders where id = $1 for update', [hint.id])).rows[0]!;
      const expectedPrices = [order.price_id, ...(invoice.initial && order.first_year_price_id ? [order.first_year_price_id] : [])].sort();
      const expectedAmount = invoice.initial ? order.amount : buyer.renewal_amount;
      if (invoice.customerId !== buyer.stripe_customer_id || (order.subscription_id && invoice.subscriptionId !== order.subscription_id) ||
          invoice.currency !== 'eur' || invoice.amount !== expectedAmount || JSON.stringify(invoice.prices.slice().sort()) !== JSON.stringify(expectedPrices) ||
          invoice.periodStart <= 0 || invoice.periodEnd <= invoice.periodStart) throw new PremiumError('payment_mismatch', 409);
      await client.query('update premium_orders set subscription_id = $2 where id = $1', [order.id, invoice.subscriptionId]);
      const refunded = (await client.query('select 1 from premium_refunds where payment_intent = $1', [invoice.paymentIntent])).rowCount! > 0;
      await client.query(`insert into premium_invoices (id, order_id, payment_intent, period_start, period_end, amount, refunded_at)
        values ($1,$2,$3,to_timestamp($4),to_timestamp($5),$6,case when $7 then now() else null end)
        on conflict (id) do nothing`, [invoice.id, order.id, invoice.paymentIntent, invoice.periodStart, invoice.periodEnd, invoice.amount, refunded]);
      if (refunded) {
        if (invoice.initial) await client.query(`update premium_orders set refunded_at = now(), token_ciphertext = null where id = $1
          and not exists (select 1 from premium_invoices where order_id = $1 and refunded_at is null)`, [order.id]);
        await reconcile(client, buyer); await client.query('commit'); return;
      }
      if (!buyer.user_id) {
        const inserted = (await client.query<{ id: string }>(`insert into users (id, username, email)
          values ($1,$2,$3) on conflict do nothing returning id`, [newId('usr'), newId('buyer'), buyer.email])).rows[0];
        let encrypted: string | null = null;
        if (inserted) {
          buyer.user_id = inserted.id;
          const token = newToken();
          await client.query('insert into tokens (id, user_id, token_hash, name) values ($1,$2,$3,$4)',
            [newId('tok'), buyer.user_id, hashToken(token), 'Premium purchase']);
          encrypted = seal(token, encryptionKey, order.id);
        } else {
          buyer.user_id = (await client.query<{ id: string }>('select id from users where lower(email) = $1', [buyer.email])).rows[0]?.id ?? null;
        }
        if (!buyer.user_id) throw new PremiumError('provisioning_failed', 503);
        await client.query('update premium_buyers set user_id = $2 where id = $1', [buyer.id, buyer.user_id]);
        if (encrypted) await client.query('update premium_orders set token_ciphertext = $2 where id = $1', [order.id, encrypted]);
      }
      await client.query('update premium_buyers set first_paid_at = coalesce(first_paid_at, now()) where id = $1', [buyer.id]);
      await client.query(`update premium_orders set user_id = $2, email = $3,
        fulfilled_at = coalesce(fulfilled_at, now()), refunded_at = null where id = $1`, [order.id, buyer.user_id, buyer.email]);
      await reconcile(client, buyer);
      await client.query('commit');
    } catch (err) { await client.query('rollback'); throw err; }
    finally { client.release(); }
  }

  async function fulfill(sessionId: string) {
    const session = await payments.retrieve(sessionId);
    if (!session.orderId || !session.invoiceId) return;
    const order = (await db.query<Order>('select * from premium_orders where id = $1', [session.orderId])).rows[0];
    if (!order || (order.session_id && order.session_id !== session.id)) return;
    await paidInvoice(session.invoiceId);
  }

  async function refund(paymentIntent: string) {
    const client = await db.connect();
    let released = false;
    try {
      await client.query('begin');
      const order = (await client.query<Order>(`select o.* from premium_orders o join premium_invoices i on i.order_id = o.id
        where i.payment_intent = $1`, [paymentIntent])).rows[0];
      const buyer = order ? (await client.query<Buyer>('select * from premium_buyers where id = $1 for update', [order.buyer_id])).rows[0] : undefined;
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`payment:${paymentIntent}`]);
      await client.query('insert into premium_refunds (payment_intent) values ($1) on conflict do nothing', [paymentIntent]);
      await client.query('update premium_invoices set refunded_at = coalesce(refunded_at, now()) where payment_intent = $1', [paymentIntent]);
      if (buyer) {
        await reconcile(client, buyer);
        await client.query(`update premium_orders set refunded_at = now(), token_ciphertext = null where id = $1
          and not exists (select 1 from premium_invoices where order_id = $1 and refunded_at is null)`, [order!.id]);
      }
      await client.query('commit');
      // Completion may have committed while this refund was waiting for the
      // payment lock. Re-enter with its now-known buyer to reconcile access.
      if (!buyer && (await client.query('select 1 from premium_invoices where payment_intent = $1', [paymentIntent])).rowCount) {
        client.release();
        released = true;
        await refund(paymentIntent);
      }
    } catch (err) { if (!released) await client.query('rollback'); throw err; }
    finally { if (!released) client.release(); }
  }

  async function status(proof: Proof) {
    let order = await getOrder(proof);
    if (!order.fulfilled_at && !order.refunded_at && order.session_id) { await fulfill(order.session_id); order = await getOrder(proof); }
    if (order.refunded_at) return { state: 'refunded' };
    if (!order.fulfilled_at) return { state: Date.now() - order.created_at.getTime() > 24 * 3600_000 ? 'expired' : 'pending' };
    const expiry = (await db.query<{ until: Date | null }>('select max(period_end) as until from premium_invoices where order_id = $1 and refunded_at is null', [order.id])).rows[0]!.until;
    return { state: 'ready', paidUntil: expiry?.toISOString() ?? null,
      canClaim: !!order.token_ciphertext && !order.claimed_at && Date.now() - order.fulfilled_at.getTime() < 7 * 86400_000,
      emailSent: !!order.email_sent_at };
  }

  async function billing(auth: Credentials) {
    const user = await authenticated(auth);
    const buyer = (await db.query<Buyer>('select * from premium_buyers where user_id = $1', [user.userId])).rows[0];
    if (!buyer) return { renewalEligible: false, paidUntil: null, subscription: null };
    const expiry = (await db.query<{ until: Date | null }>(`select max(i.period_end) as until from premium_invoices i
      join premium_orders o on o.id = i.order_id where o.buyer_id = $1 and i.refunded_at is null`, [buyer.id])).rows[0]!.until;
    const latest = (await db.query<Order>('select * from premium_orders where buyer_id = $1 and subscription_id is not null order by created_at desc limit 1', [buyer.id])).rows[0];
    const sub = latest?.subscription_id ? await payments.subscription(latest.subscription_id) : null;
    return { renewalEligible: !!expiry, paidUntil: expiry?.toISOString() ?? null,
      renewalAmount: buyer.renewal_amount, subscription: sub ? { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        renewsAt: sub.periodEnd ? new Date(sub.periodEnd * 1000).toISOString() : null } : null };
  }
  async function portal(auth: Credentials) {
    const user = await authenticated(auth);
    const buyer = (await db.query<Buyer>('select * from premium_buyers where user_id = $1', [user.userId])).rows[0];
    if (!buyer?.stripe_customer_id) throw new PremiumError('order_not_found', 404);
    return { url: await payments.portal(buyer.stripe_customer_id) };
  }
  async function claim(proof: Proof) {
    const client = await db.connect();
    try {
      await client.query('begin');
      const order = (await client.query<Order>('select * from premium_orders where id = $1 for update', [proof.orderId])).rows[0];
      checkProof(order, proof);
      if (!order.fulfilled_at || order.refunded_at) throw new PremiumError('not_ready', 409);
      if (order.claimed_at || !order.token_ciphertext || Date.now() - order.fulfilled_at.getTime() > 7 * 86400_000) {
        throw new PremiumError('credentials_already_delivered', 410);
      }
      const token = unseal(order.token_ciphertext, encryptionKey, order.id);
      const user = (await client.query<{ username: string }>('select username from users where id = $1', [order.user_id])).rows[0]!;
      await client.query(`update premium_orders set claimed_at = now(),
        token_ciphertext = case when email_sent_at is not null then null else token_ciphertext end where id = $1`, [order.id]);
      await client.query('commit');
      return { username: user.username, token };
    } catch (err) { await client.query('rollback'); throw err; }
    finally { client.release(); }
  }

  return { price: payments.price, start, fulfill, paidInvoice, refund, status, claim, billing, portal, event: payments.event };
}
export type Premium = ReturnType<typeof createPremium>;

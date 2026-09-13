import Stripe from 'stripe';

export const PREMIUM_TERMS = { billing: 'annual' as const, firstYearAmount: 6900,
  renewalAmount: 4900, currency: 'eur', vatIncluded: true };
export type Price = typeof PREMIUM_TERMS & { id: string; firstYearPriceId: string };
export type Checkout = { id: string; orderId: string | null; status: string | null;
  invoiceId: string | null; subscriptionId: string | null; customerId: string | null; url: string | null };
export type Subscription = { id: string; orderId: string | null; customerId: string;
  status: string; cancelAtPeriodEnd: boolean; periodEnd: number };
export type PaidInvoice = { id: string; orderId: string | null; subscriptionId: string;
  customerId: string; paymentIntent: string | null; paid: boolean; initial: boolean;
  amount: number; currency: string; prices: string[]; periodStart: number; periodEnd: number };
export type PaymentEvent = { type: 'checkout'; sessionId: string } | { type: 'invoice'; invoiceId: string }
  | { type: 'refund'; paymentIntent: string } | { type: 'ignore' };
export type Payments = {
  price(): Promise<Price>;
  customer(id: string, email: string): Promise<string>;
  create(order: { id: string; priceId: string; firstYearPriceId: string | null; customerId: string; createdAt: Date }): Promise<Checkout>;
  retrieve(id: string): Promise<Checkout>;
  invoice(id: string): Promise<PaidInvoice | null>;
  subscription(id: string): Promise<Subscription>;
  portal(customerId: string): Promise<string>;
  event(raw: string, signature: string): PaymentEvent;
};
const idOf = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;

export function createPayments(config: { secretKey: string; webhookSecret: string; priceId: string;
  firstYearPriceId: string; portalConfigurationId: string; origin: string },
  stripe = new Stripe(config.secretKey, { timeout: 10_000, maxNetworkRetries: 1 })): Payments {
  function present(session: Stripe.Checkout.Session): Checkout {
    return { id: session.id, orderId: session.client_reference_id, status: session.status,
      invoiceId: session.mode === 'subscription' ? idOf(session.invoice) : null,
      subscriptionId: idOf(session.subscription), customerId: idOf(session.customer), url: session.url };
  }
  return {
    async price() {
      const [annual, firstYear] = await Promise.all([
        stripe.prices.retrieve(config.priceId), stripe.prices.retrieve(config.firstYearPriceId),
      ]);
      if (!annual.active || annual.currency !== 'eur' || annual.unit_amount !== 4900 ||
          annual.tax_behavior !== 'inclusive' || annual.recurring?.interval !== 'year' ||
          annual.recurring.interval_count !== 1 || annual.recurring.usage_type !== 'licensed' ||
          !firstYear.active || firstYear.type !== 'one_time' || firstYear.unit_amount !== 2000 ||
          firstYear.currency !== 'eur' || firstYear.tax_behavior !== 'inclusive') {
        throw new Error('Premium requires inclusive EUR prices: 49 annually plus 20 on the first invoice only');
      }
      return { ...PREMIUM_TERMS, id: annual.id, firstYearPriceId: firstYear.id };
    },
    async customer(id, email) {
      return (await stripe.customers.create({ email, metadata: { premium_buyer_id: id } }, { idempotencyKey: `premium-buyer-${id}` })).id;
    },
    async create(order) {
      // The annual item is always €49. The €20 first-year item appears on the
      // first invoice only: no webhook-dependent price change at renewal time.
      return present(await stripe.checkout.sessions.create({
        mode: 'subscription', customer: order.customerId,
        line_items: [{ price: order.priceId, quantity: 1 },
          ...(order.firstYearPriceId ? [{ price: order.firstYearPriceId, quantity: 1 }] : [])],
        client_reference_id: order.id, subscription_data: { metadata: { premium_order_id: order.id } },
        automatic_tax: { enabled: true }, billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' }, adaptive_pricing: { enabled: false },
        payment_method_types: ['card'], allow_promotion_codes: false,
        success_url: `${config.origin}/checkout.html`, cancel_url: `${config.origin}/pricing.html?cancelled=1`,
        expires_at: Math.floor(order.createdAt.getTime() / 1000) + 24 * 3600,
      }, { idempotencyKey: `premium-${order.id}` }));
    },
    async retrieve(id) { return present(await stripe.checkout.sessions.retrieve(id)); },
    async invoice(id) {
      const invoice = await stripe.invoices.retrieve(id);
      const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
      if (!subscriptionId) return null;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const lines = await stripe.invoices.listLineItems(id, { limit: 10 });
      const recurring = lines.data.filter(line => line.parent?.type === 'subscription_item_details');
      const line = recurring[0];
      const validLines = !lines.has_more && recurring.length === 1 && lines.data.every(item =>
        item.quantity === 1 && !item.parent?.subscription_item_details?.proration && !!item.pricing?.price_details);
      const payments = await stripe.invoicePayments.list({ invoice: id, status: 'paid', limit: 10 });
      const payment = payments.data.find(item => item.payment.type === 'payment_intent');
      return { id, orderId: subscription.metadata.premium_order_id ?? null, subscriptionId,
        customerId: idOf(invoice.customer) ?? '', paymentIntent: idOf(payment?.payment.payment_intent),
        paid: invoice.status === 'paid' && invoice.amount_paid >= invoice.total && validLines &&
          ['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? ''),
        initial: invoice.billing_reason === 'subscription_create', amount: invoice.total,
        currency: invoice.currency, prices: lines.data.map(item => idOf(item.pricing?.price_details?.price) ?? ''),
        periodStart: line?.period.start ?? 0, periodEnd: line?.period.end ?? 0 };
    },
    async subscription(id) {
      const sub = await stripe.subscriptions.retrieve(id);
      return { id: sub.id, orderId: sub.metadata.premium_order_id ?? null, customerId: idOf(sub.customer)!,
        status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end,
        periodEnd: sub.items.data[0]?.current_period_end ?? 0 };
    },
    async portal(customerId) {
      // Validate the configured portal so it cannot silently introduce price
      // changes, quantity changes or immediate cancellation of a paid year.
      const portal = await stripe.billingPortal.configurations.retrieve(config.portalConfigurationId);
      if (!portal.active || portal.features.subscription_update.enabled || !portal.features.subscription_cancel.enabled ||
          portal.features.subscription_cancel.mode !== 'at_period_end') throw new Error('Invalid Premium portal configuration');
      return (await stripe.billingPortal.sessions.create({ customer: customerId,
        configuration: config.portalConfigurationId, return_url: `${config.origin}/account.html` })).url;
    },
    event(raw, signature) {
      const event = stripe.webhooks.constructEvent(raw, signature, config.webhookSecret);
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        return { type: 'checkout', sessionId: event.data.object.id };
      }
      if (event.type === 'invoice.paid') return { type: 'invoice', invoiceId: event.data.object.id };
      if (event.type === 'charge.refunded' && event.data.object.refunded && typeof event.data.object.payment_intent === 'string') {
        return { type: 'refund', paymentIntent: event.data.object.payment_intent };
      }
      return { type: 'ignore' };
    },
  };
}

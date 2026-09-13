import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { PremiumError, type Premium } from './premium.js';
import type { Logger } from './log.js';
import { premiumErrorFields } from './premium-diagnostics.js';

const credentials = z.object({ username: z.string().min(1).max(100), token: z.string().regex(/^gl3_[A-Za-z0-9_-]{43}$/) });
const proofSchema = z.object({
  orderId: z.string().regex(/^[a-f0-9]{48}$/),
  claimSecret: z.string().regex(/^[a-f0-9]{64}$/),
});

// Mounted behind the existing internal API authentication. Only the gl3-web
// proxy exposes these operations, never the administrative routes.
export function premiumRoutes(premium: Premium | undefined, logger: Logger) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: 'payload_too_large' }, 413) }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!premium) return c.json({ error: 'premium_unavailable' }, 503);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof PremiumError) return c.json({ error: err.code }, err.status);
    // Stripe, SQL and email errors may carry credentials or buyer information.
    logger.error('premium operation failed', { path: c.req.path, ...premiumErrorFields(err) });
    return c.json({ error: 'premium_unavailable' }, 503);
  });
  app.get('/price', async (c) => c.json(await premium!.price()));
  for (const operation of ['status', 'claim'] as const) {
    app.post(`/${operation}`, async (c) => {
      const parsed = proofSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
      return c.json(await premium![operation](parsed.data));
    });
  }
  app.post('/start', async c => {
    const parsed = proofSchema.extend({ email: z.string().email().max(254).optional(), auth: credentials.optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await premium!.start({ orderId: parsed.data.orderId, claimSecret: parsed.data.claimSecret,
      ...(parsed.data.email ? { email: parsed.data.email } : {}), ...(parsed.data.auth ? { auth: parsed.data.auth } : {}) }));
  });
  for (const operation of ['billing', 'portal'] as const) {
    app.post(`/${operation}`, async c => {
      const parsed = credentials.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid_credentials' }, 401);
      return c.json(await premium![operation](parsed.data));
    });
  }
  app.post('/webhook', async (c) => {
    let event;
    try { event = premium!.event(await c.req.text(), c.req.header('stripe-signature') ?? ''); }
    catch { return c.json({ error: 'invalid_signature' }, 400); }
    if (event.type === 'checkout') await premium!.fulfill(event.sessionId);
    if (event.type === 'invoice') await premium!.paidInvoice(event.invoiceId);
    if (event.type === 'refund') await premium!.refund(event.paymentIntent);
    return c.json({ received: true });
  });
  return app;
}

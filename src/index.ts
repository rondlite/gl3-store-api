import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createPayments } from './payments.js';
import { createPremium } from './premium.js';
import { createResendMailer, startPurchaseMail } from './premium-mail.js';
import { startCatalogRefresh } from './catalog-refresh.js';
import { createPool } from './db.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';
import { fetchManifest } from './registry.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createPool(env.DATABASE_URL);
const premium = env.STRIPE_SECRET_KEY ? createPremium({
  db,
  encryptionKey: Buffer.from(env.PREMIUM_TOKEN_KEY!, 'hex'),
  payments: createPayments({ secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET!, priceId: env.STRIPE_PREMIUM_PRICE_ID!,
    firstYearPriceId: env.STRIPE_FIRST_YEAR_PRICE_ID!, portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID!,
    origin: env.PUBLIC_ORIGIN }),
}) : undefined;
const stopPurchaseMail = premium ? startPurchaseMail(db, Buffer.from(env.PREMIUM_TOKEN_KEY!, 'hex'),
  createResendMailer({ apiKey: env.RESEND_API_KEY!, from: env.PREMIUM_EMAIL_FROM!, origin: env.PUBLIC_ORIGIN }), logger)
  : async () => {};
const app = createApp({
  ...(premium ? { premium } : {}),
  db,
  internalApiKey: env.INTERNAL_API_KEY,
  logger,
  catalogStaleMs: 2 * env.REGISTRY_REFRESH_MS,
});

// A pool error with no listener is an unhandled 'error' event, which takes the
// process down -- and a dropped backend connection is routine, not fatal.
db.on('error', (err) => logger.error('idle client error', { err: err.message }));

// The refresher is started here rather than inside createApp so the app factory
// stays pure: tests construct an app without a timer starting behind them.
let stopCatalogRefresh: () => void = () => {};

if (
  env.REGISTRY_URL !== undefined &&
  env.REGISTRY_USERNAME !== undefined &&
  env.REGISTRY_TOKEN !== undefined
) {
  const registry = {
    url: env.REGISTRY_URL,
    username: env.REGISTRY_USERNAME,
    token: env.REGISTRY_TOKEN,
    // Longer than the auth plugin's own 5s timeout: the registry answers this
    // call by calling back into this service, so a slow inner hop should
    // surface as the plugin's failure rather than an ambiguous outer one.
    timeoutMs: 10_000,
  };

  stopCatalogRefresh = startCatalogRefresh(
    db,
    (packageName) => fetchManifest(registry, packageName),
    logger,
    env.REGISTRY_REFRESH_MS
  );
  logger.info('catalog refresh enabled', { intervalMs: env.REGISTRY_REFRESH_MS });
} else {
  logger.warn('catalog refresh disabled: REGISTRY_URL, REGISTRY_USERNAME or REGISTRY_TOKEN unset');
}

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', { port: info.port });
});

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopCatalogRefresh();
  await stopPurchaseMail();
  server.close(() => {
    db.end().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createPool } from './db.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createPool(env.DATABASE_URL);
const app = createApp({ db, internalApiKey: env.INTERNAL_API_KEY, logger });

// A pool error with no listener is an unhandled 'error' event, which takes the
// process down -- and a dropped backend connection is routine, not fatal.
db.on('error', (err) => logger.error('idle client error', { err: err.message }));

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', { port: info.port });
});

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  server.close(() => {
    db.end().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

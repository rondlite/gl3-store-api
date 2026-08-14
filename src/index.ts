import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createPool } from './db.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL);
const app = createApp({ db, internalApiKey: env.INTERNAL_API_KEY });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`gl3-store-api listening on :${info.port}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.end().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { Db } from './db.js';
import { type Logger, silentLogger } from './log.js';
import { SCOPE, isSellablePackage, parsePattern } from './packages.js';
import {
  authenticate,
  authorizePackage,
  createTokenForUser,
  createUser,
  grantEntitlement,
  revokeEntitlement,
  revokeToken,
} from './service.js';

export type AppDeps = {
  db: Db;
  internalApiKey: string;
  logger?: Logger;
};

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; compare a fixed-size digest-like padding instead by checking length
  // separately and still running the comparison.
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function createApp({ db, internalApiKey, logger = silentLogger() }: AppDeps) {
  const app = new Hono();

  // One line per request. Paths carry ids but never secrets, and bodies and
  // headers are not logged.
  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    await next();
    logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - startedAt,
    });
  });

  // Without this, an unhandled throw becomes a bare 500 with nothing written
  // anywhere -- the failure mode is a caller staring at a 500 and empty logs.
  app.onError((err, c) => {
    logger.error('unhandled error', {
      method: c.req.method,
      path: c.req.path,
      err: err.message,
      // Postgres puts the useful part in these, not in the message.
      code: (err as { code?: string }).code,
      detail: (err as { detail?: string }).detail,
      stack: err.stack,
    });
    // The client gets nothing back: error text from this service can carry SQL
    // and column names.
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/healthz', async (c) => {
    try {
      await db.query('select 1');
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // Everything below is machine-to-machine: the registry plugin and internal
  // tooling only. There is no end-user-facing auth on this service.
  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const [scheme, value] = header.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !value || !constantTimeEquals(value, internalApiKey)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    return next();
  });

  app.post(
    '/v1/auth/authenticate',
    zValidator('json', z.object({ username: z.string().min(1), token: z.string().min(1) })),
    async (c) => {
      const body = c.req.valid('json');
      const user = await authenticate(db, body);

      if (!user) {
        return c.json({ error: 'invalid_credentials' }, 401);
      }

      return c.json({ userId: user.userId, username: user.username, groups: user.groups });
    }
  );

  app.post(
    '/v1/auth/authorize-package',
    zValidator('json', z.object({ userId: z.string().min(1), package: z.string().min(1) })),
    async (c) => {
      const body = c.req.valid('json');

      // A package outside the sellable scope should never have reached this
      // endpoint; the plugin defers those to the registry's own config rules.
      if (!isSellablePackage(body.package)) {
        return c.json({ error: 'not_entitled', reason: 'out_of_scope' }, 403);
      }

      const allowed = await authorizePackage(db, body);
      return allowed ? c.json({ ok: true }) : c.json({ error: 'not_entitled' }, 403);
    }
  );

  app.post(
    '/v1/admin/users',
    zValidator(
      'json',
      z.object({
        username: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9._-]+$/, 'npm usernames are alphanumeric plus . _ -'),
        email: z.string().email(),
        roles: z.array(z.string().min(1)).default([]),
      })
    ),
    async (c) => {
      const body = c.req.valid('json');
      try {
        const user = await createUser(db, body);
        return c.json(user, 201);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return c.json({ error: 'already_exists' }, 409);
        }
        throw err;
      }
    }
  );

  app.post(
    '/v1/admin/users/:userId/tokens',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).optional(),
        expiresAt: z.coerce.date().optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid('json');
      try {
        const created = await createTokenForUser(db, {
          userId: c.req.param('userId'),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        });
        // The plaintext token appears in this response and nowhere else.
        return c.json(created, 201);
      } catch (err) {
        if ((err as { code?: string }).code === '23503') {
          return c.json({ error: 'no_such_user' }, 404);
        }
        throw err;
      }
    }
  );

  app.delete('/v1/admin/tokens/:tokenId', async (c) => {
    const revoked = await revokeToken(db, c.req.param('tokenId'));
    return revoked ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  app.post(
    '/v1/admin/users/:userId/entitlements',
    zValidator(
      'json',
      z.object({
        package: z.string().min(1),
        source: z.string().min(1).optional(),
        expiresAt: z.coerce.date().optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid('json');

      // Checked here rather than in the catch below so that a database failure
      // is not reported to the caller as a bad package name.
      if (parsePattern(body.package) === null) {
        return c.json(
          { error: 'invalid_package', message: `expected "${SCOPE}name" or "${SCOPE}*"` },
          400
        );
      }

      try {
        await grantEntitlement(db, {
          userId: c.req.param('userId'),
          package: body.package,
          ...(body.source !== undefined ? { source: body.source } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        });
        return c.json({ ok: true }, 201);
      } catch (err) {
        if ((err as { code?: string }).code === '23503') {
          return c.json({ error: 'no_such_user' }, 404);
        }
        throw err;
      }
    }
  );

  app.delete(
    '/v1/admin/users/:userId/entitlements',
    zValidator('json', z.object({ package: z.string().min(1) })),
    async (c) => {
      const revoked = await revokeEntitlement(db, {
        userId: c.req.param('userId'),
        package: c.req.valid('json').package,
      });
      return revoked ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
    }
  );

  return app;
}

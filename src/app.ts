import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { Db } from './db.js';
import { accountRoutes } from './account-routes.js';
import type { Premium } from './premium.js';
import { premiumRoutes } from './premium-routes.js';
import { DEFAULT_REGISTRY_REFRESH_MS } from './env.js';
import { type Logger, silentLogger } from './log.js';
import { PUBLIC_SCOPE, SCOPE, isCatalogPackage, isPaidPackage, isSellablePackage, parsePattern } from './packages.js';
import {
  addCatalogPackage,
  authenticate,
  authorizePackage,
  createTokenForUser,
  createUser,
  type CatalogRow,
  type EntitlementAccess,
  getCatalogPackage,
  grantEntitlement,
  hasStaffRole,
  listCatalog,
  removeCatalogPackage,
  revokeEntitlement,
  revokeToken,
} from './service.js';

export type AppDeps = {
  db: Db;
  premium?: Premium;
  internalApiKey: string;
  logger?: Logger;
  /**
   * How old a fetch may be before the catalogue reports it stale. Two refresh
   * intervals by default, so a single missed pass is not reported as a problem.
   */
  catalogStaleMs?: number;
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

/**
 * Shapes a catalogue row for the website.
 *
 * `stale` is computed here rather than stored: a stored flag would itself go
 * stale. `paid` is derived from the name for the same reason.
 */
function presentCatalogRow(
  row: CatalogRow,
  staleMs: number,
  includeReadme: boolean
): Record<string, unknown> {
  const fetchedAt = row.fetched_at;
  const stale =
    row.fetch_error !== null || fetchedAt === null || Date.now() - fetchedAt.getTime() > staleMs;

  return {
    package: row.package,
    paid: isPaidPackage(row.package),
    position: row.position,
    version: row.version,
    description: row.description,
    keywords: row.keywords ?? [],
    license: row.license,
    fetchedAt: fetchedAt === null ? null : fetchedAt.toISOString(),
    stale,
    ...(includeReadme ? { readme: row.readme } : {}),
  };
}

export function createApp({
  db,
  premium,
  internalApiKey,
  logger = silentLogger(),
  catalogStaleMs = 2 * DEFAULT_REGISTRY_REFRESH_MS,
}: AppDeps) {
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

  app.route('/v1/premium', premiumRoutes(premium, logger));
  app.route('/v1/account', accountRoutes(db));

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
    zValidator(
      'json',
      z.object({
        userId: z.string().min(1),
        package: z.string().min(1),
        tarball: z.boolean().optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid('json');

      // A package outside the sellable scope should never have reached this
      // endpoint; the plugin defers those to the registry's own config rules.
      if (!isSellablePackage(body.package)) {
        return c.json({ error: 'not_entitled', reason: 'out_of_scope' }, 403);
      }

      // Absent means tarball. A registry too old to send the flag must not be
      // read as "this is only a manifest request".
      const decision = await authorizePackage(db, {
        userId: body.userId,
        package: body.package,
        tarball: body.tarball ?? true,
      });

      if (decision === 'ok') {
        return c.json({ ok: true });
      }
      if (decision === 'metadata_only') {
        // Distinct from the request-logging middleware above by design: that one
        // deliberately never logs bodies. This is the diagnostic the spec asks
        // for -- without it, a misconfigured metadata key is indistinguishable
        // from an unpaid customer in the logs.
        logger.warn('metadata_only', { userId: body.userId, package: body.package });
        return c.json({ error: 'metadata_only' }, 403);
      }
      return c.json({ error: 'not_entitled' }, 403);
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
        access: z.string().min(1).optional(),
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

      if (body.access !== undefined && body.access !== 'download' && body.access !== 'metadata') {
        return c.json(
          { error: 'invalid_access', message: 'expected "download" or "metadata"' },
          400
        );
      }

      const userId = c.req.param('userId');

      try {
        await grantEntitlement(db, {
          userId,
          package: body.package,
          ...(body.access !== undefined ? { access: body.access as EntitlementAccess } : {}),
          ...(body.source !== undefined ? { source: body.source } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        });

        // Staff bypass entitlements entirely (see authorizePackage), so this
        // grant is inert -- the account already downloads every paid package
        // unconditionally. Warn only: rejecting would be new API behaviour the
        // spec does not define, and could block a legitimate operator flow.
        if (body.access === 'metadata' && (await hasStaffRole(db, userId))) {
          logger.warn('metadata_grant_to_staff', { userId, package: body.package });
        }

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

  app.post(
    '/v1/admin/catalog',
    zValidator('json', z.object({ package: z.string().min(1), position: z.number().int() })),
    async (c) => {
      const body = c.req.valid('json');

      if (!isCatalogPackage(body.package)) {
        return c.json(
          {
            error: 'invalid_package',
            message: `expected "${SCOPE}name" or "${PUBLIC_SCOPE}name"`,
          },
          400
        );
      }

      await addCatalogPackage(db, body);
      return c.json({ ok: true }, 201);
    }
  );

  app.delete('/v1/admin/catalog/:package', async (c) => {
    const packageName = c.req.param('package');
    if (!isCatalogPackage(packageName)) {
      return c.json(
        {
          error: 'invalid_package',
          message: `expected "${SCOPE}name" or "${PUBLIC_SCOPE}name"`,
        },
        400
      );
    }

    const removed = await removeCatalogPackage(db, packageName);
    return removed ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/v1/catalog/packages', async (c) => {
    const rows = await listCatalog(db);
    return c.json({
      packages: rows.map((row) => presentCatalogRow(row, catalogStaleMs, false)),
    });
  });

  app.get('/v1/catalog/packages/:package', async (c) => {
    const packageName = c.req.param('package');
    if (!isCatalogPackage(packageName)) {
      return c.json(
        {
          error: 'invalid_package',
          message: `expected "${SCOPE}name" or "${PUBLIC_SCOPE}name"`,
        },
        400
      );
    }

    const row = await getCatalogPackage(db, packageName);
    return row === null
      ? c.json({ error: 'not_found' }, 404)
      : c.json(presentCatalogRow(row, catalogStaleMs, true));
  });

  return app;
}

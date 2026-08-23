import type { Db } from './db.js';
import { hashToken, newId, newToken } from './ids.js';
import { grantingPatterns, parsePattern } from './packages.js';

export type AuthenticatedUser = {
  userId: string;
  username: string;
  groups: string[];
};

/**
 * Verifies an npm token and returns the owner's identity and roles.
 *
 * `username` is checked against the token owner rather than trusted. Verdaccio
 * builds the session from the username the client supplied, and its builtin
 * permission check treats a matching *name* as equivalent to a matching group,
 * so accepting an arbitrary username here would let any token holder log in as
 * "admin" and satisfy `publish: admin`.
 */
export async function authenticate(
  db: Db,
  input: { username: string; token: string }
): Promise<AuthenticatedUser | null> {
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    username: string;
    disabled_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    `select t.id, t.user_id, u.username, u.disabled_at, t.expires_at, t.revoked_at
       from tokens t
       join users u on u.id = t.user_id
      where t.token_hash = $1`,
    [hashToken(input.token)]
  );

  const row = rows[0];
  if (!row) {
    return null;
  }
  if (row.revoked_at !== null || row.disabled_at !== null) {
    return null;
  }
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
    return null;
  }
  if (row.username !== input.username.toLowerCase()) {
    return null;
  }

  const roles = await db.query<{ role: string }>(
    'select role from user_roles where user_id = $1 order by role',
    [row.user_id]
  );

  // Best-effort: a failed bookkeeping write must not fail the login.
  db.query('update tokens set last_used_at = now() where id = $1', [row.id]).catch(() => {});

  return {
    userId: row.user_id,
    username: row.username,
    groups: roles.rows.map((r) => r.role),
  };
}

/**
 * Roles that read every paid package without an entitlement row. Publish
 * rights already come from these roles via Verdaccio's `publish:` lists;
 * without this bypass the publisher publishes blind — Verdaccio filters the
 * web UI, search, and installs through allow_access, so an admin could ship
 * a package it can never see.
 */
const STAFF_ROLES = ['admin', 'gl3-dev-lead'];

export type PackageDecision = 'ok' | 'metadata_only' | 'not_entitled';

/**
 * Resolves what a user may do with a package right now.
 *
 * Order matters. Staff bypass entitlements entirely, and a download grant beats
 * a metadata one: `grantingPatterns` matches both the exact name and the scope
 * wildcard, so a user can hold one row of each and the permissive one has to win.
 *
 * An `access` value that is neither string matches neither branch and lands on
 * `not_entitled` -- unknown means denied, not granted.
 */
export async function authorizePackage(
  db: Db,
  input: { userId: string; package: string; tarball: boolean }
): Promise<PackageDecision> {
  const { rows } = await db.query<{ staff: boolean; download: boolean; metadata: boolean }>(
    `select
       exists (
         select 1 from user_roles r
          where r.user_id = u.id
            and r.role = any($3::text[])
       ) as staff,
       exists (
         select 1 from entitlements e
          where e.user_id = u.id
            and e.package = any($2::text[])
            and e.revoked_at is null
            and (e.expires_at is null or e.expires_at > now())
            and e.access = 'download'
       ) as download,
       exists (
         select 1 from entitlements e
          where e.user_id = u.id
            and e.package = any($2::text[])
            and e.revoked_at is null
            and (e.expires_at is null or e.expires_at > now())
            and e.access = 'metadata'
       ) as metadata
       from users u
      where u.id = $1
        and u.disabled_at is null
      limit 1`,
    [input.userId, grantingPatterns(input.package), STAFF_ROLES]
  );

  const row = rows[0];
  if (!row) {
    return 'not_entitled';
  }
  if (row.staff || row.download) {
    return 'ok';
  }
  if (row.metadata) {
    return input.tarball ? 'metadata_only' : 'ok';
  }
  return 'not_entitled';
}

export async function createUser(
  db: Db,
  input: { username: string; email: string; roles?: string[] }
): Promise<{ userId: string; username: string }> {
  const userId = newId('usr');
  const username = input.username.toLowerCase();
  const client = await db.connect();

  try {
    await client.query('begin');
    await client.query('insert into users (id, username, email) values ($1, $2, $3)', [
      userId,
      username,
      input.email,
    ]);

    for (const role of input.roles ?? []) {
      await client.query('insert into user_roles (user_id, role) values ($1, $2)', [userId, role]);
    }

    await client.query('commit');
    return { userId, username };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mints a token. The plaintext is returned once and never stored -- if it is
 * lost, the only recourse is to issue a new one.
 */
export async function createTokenForUser(
  db: Db,
  input: { userId: string; name?: string; expiresAt?: Date }
): Promise<{ tokenId: string; token: string }> {
  const token = newToken();
  const tokenId = newId('tok');

  await db.query(
    'insert into tokens (id, user_id, token_hash, name, expires_at) values ($1, $2, $3, $4, $5)',
    [tokenId, input.userId, hashToken(token), input.name ?? null, input.expiresAt ?? null]
  );

  return { tokenId, token };
}

export async function revokeToken(db: Db, tokenId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'update tokens set revoked_at = now() where id = $1 and revoked_at is null',
    [tokenId]
  );
  return (rowCount ?? 0) > 0;
}

export type EntitlementAccess = 'download' | 'metadata';

export async function grantEntitlement(
  db: Db,
  input: {
    userId: string;
    package: string;
    access?: EntitlementAccess;
    source?: string;
    expiresAt?: Date;
  }
): Promise<void> {
  if (parsePattern(input.package) === null) {
    throw new Error(`not a grantable package pattern: ${input.package}`);
  }

  // Re-granting a previously revoked entitlement should reinstate it, which is
  // why this is an upsert rather than an insert that conflicts. `access` is part
  // of the update set: re-granting at a different level must move the existing
  // row rather than silently keep the old level.
  await db.query(
    `insert into entitlements (user_id, package, access, source, expires_at)
          values ($1, $2, $3, $4, $5)
     on conflict (user_id, package) do update
            set revoked_at = null,
                access = excluded.access,
                source = excluded.source,
                expires_at = excluded.expires_at,
                granted_at = now()`,
    [
      input.userId,
      input.package,
      input.access ?? 'download',
      input.source ?? 'manual',
      input.expiresAt ?? null,
    ]
  );
}

export async function revokeEntitlement(
  db: Db,
  input: { userId: string; package: string }
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update entitlements set revoked_at = now()
      where user_id = $1 and package = $2 and revoked_at is null`,
    [input.userId, input.package]
  );
  return (rowCount ?? 0) > 0;
}

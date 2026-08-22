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

/**
 * True if the user currently holds a live entitlement covering the package,
 * or is staff.
 */
export async function authorizePackage(
  db: Db,
  input: { userId: string; package: string }
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select true as ok
       from users u
      where u.id = $1
        and u.disabled_at is null
        and (
          exists (
            select 1 from user_roles r
             where r.user_id = u.id and r.role = any($3::text[])
          )
          or exists (
            select 1 from entitlements e
             where e.user_id = u.id
               and e.package = any($2::text[])
               and e.revoked_at is null
               and (e.expires_at is null or e.expires_at > now())
          )
        )
      limit 1`,
    [input.userId, grantingPatterns(input.package), STAFF_ROLES]
  );

  return rows.length > 0;
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

export async function grantEntitlement(
  db: Db,
  input: { userId: string; package: string; source?: string; expiresAt?: Date }
): Promise<void> {
  if (parsePattern(input.package) === null) {
    throw new Error(`not a grantable package pattern: ${input.package}`);
  }

  // Re-granting a previously revoked entitlement should reinstate it, which is
  // why this is an upsert rather than an insert that conflicts.
  await db.query(
    `insert into entitlements (user_id, package, source, expires_at)
          values ($1, $2, $3, $4)
     on conflict (user_id, package) do update
            set revoked_at = null,
                source = excluded.source,
                expires_at = excluded.expires_at,
                granted_at = now()`,
    [input.userId, input.package, input.source ?? 'manual', input.expiresAt ?? null]
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

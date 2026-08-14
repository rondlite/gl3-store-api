-- Users of the GL3 marketplace.
--
-- `id` is the value the Verdaccio plugin carries around as the `uid:` group and
-- sends back on /authorize-package, so it must be stable for the life of the
-- account: tokens minted today keep referencing it.
--
-- `username` is what the user types at `npm login`. It has to be stored and
-- checked, not just accepted: Verdaccio's builtin permission check matches
-- `name === group || groups.includes(group)` (packages/auth/src/utils.ts), so a
-- user who logs in as the literal name "admin" with their own valid token would
-- satisfy `publish: admin` by name alone. /authenticate therefore rejects any
-- username that is not the token owner's.
create table users (
  id text primary key,
  username text not null,
  email text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- Case-insensitive uniqueness without requiring the citext extension, which is
-- not installed by default on managed Postgres. npm lowercases usernames, so
-- the stored value is lowercased at the API boundary too.
create unique index users_username_idx on users (username);
create unique index users_email_lower_idx on users (lower(email));

-- Roles are returned verbatim as Verdaccio groups, so these strings have to
-- match the names used in the registry's config.yaml `publish:`/`unpublish:`
-- lists (currently: admin, gl3-dev-lead).
create table user_roles (
  user_id text not null references users (id) on delete cascade,
  role text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- npm tokens. Only the SHA-256 of the token is stored: a leaked database dump
-- must not yield working credentials. The tokens are 32 random bytes, so a fast
-- hash is appropriate here -- there is no low-entropy secret to brute-force,
-- and /authenticate is on the hot path of every npm request.
create table tokens (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  token_hash bytea not null unique,
  name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index tokens_user_id_idx on tokens (user_id);

-- Entitlements: which packages a user may install.
--
-- `package` is either an exact name ('@gl3/plugin-a') or a scope wildcard
-- ('@gl3/*') for an all-access plan. Anything else is rejected at the API
-- boundary so the matching rules stay to those two shapes.
create table entitlements (
  user_id text not null references users (id) on delete cascade,
  package text not null,
  source text not null default 'manual',
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  primary key (user_id, package)
);

create index entitlements_user_id_idx on entitlements (user_id);

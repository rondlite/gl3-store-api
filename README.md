# gl3-store-api

Auth and entitlement API for the GL3 Marketplace private npm registry.

The registry itself is [Verdaccio](https://github.com/rondlite/verdaccio) running the
`verdaccio-auth-gl3` plugin. That plugin holds no user data: on every login and every
package fetch it calls this service, which owns the users, tokens, and "who has bought
what" records.

```
npm install @gl3-plugins/plugin-a
        │
        ▼
   Verdaccio  ──(verdaccio-auth-gl3)──►  gl3-store-api  ──►  Postgres
```

## How auth works end to end

1. A user runs `npm login --registry https://registry.gl3.dev` and pastes a token issued
   by this service (`gl3_...`) as the password.
2. Verdaccio calls the plugin's `authenticate`, which POSTs to `/v1/auth/authenticate`.
   The response's `groups` become the user's Verdaccio groups, plus a synthetic
   `uid:<userId>` entry.
3. On each package request Verdaccio calls `allow_access`. For `@gl3-plugins/*` names (the
   paid scope; `@gl3/*` is the public engine-core scope and never reaches this service) the plugin
   pulls the user id back out of that `uid:` group and POSTs `/v1/auth/authorize-package`.
4. A 200 grants access. A 403 is turned into a hard denial by the plugin — it must not
   return "false", because in Verdaccio that means *defer to the next plugin*, and the
   builtin fallback would then grant the package to any authenticated user.

Two details are load-bearing:

- **The user id travels inside `groups`.** Verdaccio only persists `name` and
  `real_groups` into the session token, so there is nowhere else to put it.
- **`/v1/auth/authenticate` rejects a valid token presented under the wrong username.**
  Verdaccio's permission check matches `name === group || groups.includes(group)`, so a
  user who logs in as the literal name `admin` would satisfy `publish: admin` on their
  name alone. The username is therefore checked against the token's owner, not just
  accepted. There is a regression test for this.

## Endpoints

Every `/v1/*` route requires `Authorization: Bearer $INTERNAL_API_KEY` — the shared
secret between this service and the registry. There is no end-user-facing auth here;
`/healthz` is the only unauthenticated route.

### Called by the registry plugin

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/v1/auth/authenticate` | `{username, token}` | `200 {userId, username, groups}` / `401` |
| POST | `/v1/auth/authorize-package` | `{userId, package, tarball?}` | `200 {ok:true}` / `403 {error:"not_entitled"}` / `403 {error:"metadata_only"}` |

### Admin

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/v1/admin/users` | `{username, email, roles?}` | `201 {userId, username}` / `409` |
| POST | `/v1/admin/users/:userId/tokens` | `{name?, expiresAt?}` | `201 {tokenId, token}` / `404` |
| DELETE | `/v1/admin/tokens/:tokenId` | — | `200` / `404` |
| POST | `/v1/admin/users/:userId/entitlements` | `{package, access?, source?, expiresAt?}` | `201` / `400` / `404` |
| DELETE | `/v1/admin/users/:userId/entitlements` | `{package}` | `200` / `404` |

The plaintext token is returned by the mint call and never again — only a SHA-256 hash
is stored. (A high-entropy random token does not need a slow KDF; there is nothing to
brute-force offline.)

`package` on an entitlement must be either an exact name (`@gl3-plugins/plugin-a`) or the scope
wildcard `@gl3-plugins/*` for an all-access plan. Anything else is a 400. Keeping it to those
two shapes makes authorization an equality lookup instead of pattern matching per
request.

An entitlement also carries an `access` level, `download` (the default) or
`metadata`. A `metadata` entitlement reads manifests but is refused tarballs, which
is what lets the storefront list the catalogue with a credential that cannot download
a single paid plugin. `tarball` on `/v1/auth/authorize-package` defaults to **true**
when absent, so a registry too old to send it fails closed.

Resolution order is: staff roles first (they bypass entitlements entirely so a
publisher is not blind to what they just published), then any `download` grant, then
`metadata`. A `download` grant beats a `metadata` one, because `grantingPatterns`
matches both the exact name and the scope wildcard and a user can hold one row of
each.

## Development

Needs Node >= 22 and a Postgres you can reach.

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL and INTERNAL_API_KEY
npm run migrate
npm run dev               # tsx watch, listens on $PORT (default 8080)
```

Mint yourself a user and a token:

```bash
KEY=$(grep INTERNAL_API_KEY .env | cut -d= -f2)

curl -sX POST localhost:8080/v1/admin/users \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"username":"ron","email":"ron@gl3.dev","roles":["admin"]}'

curl -sX POST localhost:8080/v1/admin/users/usr_xxx/tokens \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"laptop"}'
```

### Tests

The suite runs against a real Postgres — no mocks, since most of what is being tested is
SQL. Point `TEST_DATABASE_URL` at a throwaway database; it is truncated between tests.

```bash
createdb gl3_store_test
TEST_DATABASE_URL="postgres:///gl3_store_test" npm test
```

Test files do not run in parallel (`fileParallelism: false` in `vitest.config.ts`): they
share one database, so a parallel file's truncate would delete rows another file is
midway through using.

### Migrations

`migrations/*.sql` are applied in filename order, each in its own transaction alongside
its row in `schema_migrations`, so a migration that fails halfway leaves no trace and can
be re-run. Adding a change means adding `002_whatever.sql`; existing files are never
edited.

The whole run holds a Postgres advisory lock. `create table if not exists` is not
actually concurrency-safe — two processes issuing it at the same instant race on the
system catalog and one dies on a duplicate key in `pg_type`. That happens any time two
instances boot together, so the lock is not a test-only concern.

## Deployment

`npm run build && node dist/index.js`, or the image published to
`ghcr.io/rondlite/gl3-store-api` on every push to the default branch.

Migrations are deliberately **not** run on boot; run `node dist/migrate.js` as a separate
step so a rolling deploy cannot have N replicas racing to alter the schema.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `INTERNAL_API_KEY` | yes | Min 32 chars. Must match the registry's `INTERNAL_API_KEY`. `openssl rand -base64 48` |
| `PORT` | no | Default 8080 |
| `LOG_LEVEL` | no | Default `info` |

`/healthz` returns 503 when the database is unreachable, so it works as a readiness
probe.

### The storefront metadata account

The storefront reads the plugin catalogue through an account that can see every
manifest in the paid scope and download none of them.

```bash
KEY=$(grep INTERNAL_API_KEY .env | cut -d= -f2)

# roles MUST be empty: a staff role bypasses entitlements entirely and would
# give this token every tarball.
curl -sX POST localhost:8080/v1/admin/users \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"username":"storefront","email":"storefront@gl3.dev","roles":[]}'

curl -sX POST localhost:8080/v1/admin/users/usr_xxx/tokens \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"catalogue"}'

curl -sX POST localhost:8080/v1/admin/users/usr_xxx/entitlements \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"package":"@gl3-plugins/*","access":"metadata","source":"storefront"}'
```

The token is returned once. It becomes `REGISTRY_TOKEN` alongside
`REGISTRY_USERNAME=storefront` wherever the catalogue is fetched.

Verify it before trusting it — the second call must fail:

```bash
npm view @gl3-plugins/plugin-a --registry https://npm.gl3.dev   # succeeds
npm pack @gl3-plugins/plugin-a --registry https://npm.gl3.dev   # 403 metadata_only
```

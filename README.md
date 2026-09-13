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

1. A user runs `npm login --registry https://npm.gl3.dev` and pastes a token issued
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
| POST | `/v1/admin/catalog` | `{package, position}` | `201` / `400` |
| DELETE | `/v1/admin/catalog/:package` | — | `200` / `404` |

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
each. A missing or disabled user, or a user with no live matching entitlement,
resolves to `not_entitled`.

### Catalogue

The website's package directory. `POST /v1/admin/catalog` curates the list — the
`position` you give it is the only value you own; everything else is a cache of the
package's registry manifest, refreshed on a timer.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/catalog/packages` | the ordered list, without readmes |
| GET | `/v1/catalog/packages/:package` | one package, including its readme |

The catalogue spans both GL3 scopes: `@gl3-plugins/*`, which premium unlocks, and the
public `@gl3/*`, which is the SDK developers build against. `paid` in the response is
derived from the scope. Scoped names in a path must be URL-encoded — an unencoded slash
reads as two path segments and never matches the route.

`stale` is true when the last fetch failed, or has not happened, or is older than two
refresh intervals. A failed refresh never clears cached metadata, so an unreachable
registry shows as stale data rather than an empty site.

Refreshing needs the storefront service account from the metadata-access runbook below,
and the refresher only starts when all three of `REGISTRY_URL`, `REGISTRY_USERNAME` and
`REGISTRY_TOKEN` are set:

```bash
curl -sX POST localhost:8080/v1/admin/catalog \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"package":"@gl3-plugins/plugin-a","position":10}'
```

#### Managing the catalogue without the API

This service runs on an internal network with no public route, so reaching the admin
routes with `curl` means already being inside that network. `catalog-cli` avoids the
problem by talking to Postgres directly. It is a one-shot command in the same shape as
the migration runner, and it needs no API key at all.

```bash
node dist/catalog-cli.js add <package> [position]
node dist/catalog-cli.js list
node dist/catalog-cli.js remove <package>
node dist/catalog-cli.js refresh
```

`add`, `list` and `remove` need only `DATABASE_URL`. `refresh` also needs
`REGISTRY_URL`, `REGISTRY_USERNAME` and `REGISTRY_TOKEN`, and it names any that are
missing rather than failing obscurely. Nothing here ever wants `INTERNAL_API_KEY`.

Omitting the position appends to the end of the list, leaving a gap of ten so a package
can later be slotted between two existing entries without renumbering. Re-adding a
package that is already catalogued repositions it instead of duplicating it.

`refresh` runs one pass immediately rather than waiting up to `REGISTRY_REFRESH_MS`,
which is what you want straight after registering something. It exits non-zero if any
package failed to fetch, so a revoked credential is not reported to a deploy script as
success. A package the registry does not have yet counts as skipped rather than failed.

In a container, run it the same way as a migration:

```bash
docker run --rm --network <net> -e DATABASE_URL=... \
  ghcr.io/rondlite/gl3-store-api:main node dist/catalog-cli.js list
```

In development, `npm run catalog -- add @gl3/plugin-sdk 10`.

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
| `REGISTRY_URL` | no | Registry base URL, e.g. `https://npm.gl3.dev`. Unset disables catalogue refresh |
| `REGISTRY_USERNAME` | no | The storefront service account |
| `REGISTRY_TOKEN` | no | Its `gl3_` token, sent as HTTP Basic |
| `REGISTRY_REFRESH_MS` | no | Default 900000 (15 minutes) |

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

**Re-granting this entitlement later without `"access":"metadata"` silently promotes it to
`download`** — the grant route is an upsert and `access` defaults to `download` on every call,
including a re-grant. Always pass `"access":"metadata"` explicitly when touching this account's
entitlement again, or the storefront key quietly gains the ability to download every paid
tarball.

The token is returned once. It becomes `REGISTRY_TOKEN` alongside
`REGISTRY_USERNAME=storefront` wherever the catalogue is fetched.

Verify it before trusting it — the second call must fail:

```bash
npm view @gl3-plugins/plugin-a --registry https://npm.gl3.dev   # succeeds
npm pack @gl3-plugins/plugin-a --registry https://npm.gl3.dev   # 403 (store-api logs metadata_only)
```

The npm client never sees the code `metadata_only` — the plugin turns any denial into its own
`user is not entitled to package ...` message. Check this service's logs for the `metadata_only`
line to confirm the denial reached this branch rather than `not_entitled`.

## Annual Premium storefront

Premium costs **€69 for the first year, then €49 annually**, including VAT. Returning
buyers pay €49 after a lapse by signing in with their existing npm credentials.
Premium support uses [Discord](https://discord.gg/6U8ezKE8T). Resend sends transactional
purchase and renewal emails.

The website proxies a small set of `/v1/premium/*` and `/v1/account/*` routes; all still
require the internal API key. Registry access is granted only from verified paid
invoices. The entitlement expires at the end of the paid period. Installed plugins
continue running after expiry; credentials remain valid for signing in and renewing.

### Stripe configuration

Create these prices in the same Stripe account and mode as the secret key:

| Setting | Required Stripe configuration |
| --- | --- |
| `STRIPE_PREMIUM_PRICE_ID` | €49 EUR, recurring every year, licensed quantity, inclusive tax |
| `STRIPE_FIRST_YEAR_PRICE_ID` | €20 EUR, one-time, inclusive tax; label it as the first-year supplement |
| `STRIPE_PORTAL_CONFIGURATION_ID` | An active Customer Portal configuration; allow cancellation **at period end**, payment-method updates and invoices; disable subscription plan/quantity changes |

The first invoice combines €49 annual access with the €20 first-year supplement.
Stripe automatically excludes the one-time item from later invoices. Returning-customer
checkout omits it. Both items require inclusive tax, so tax is not added above €69/€49.
Use the appropriate product tax code and configure Stripe Tax and applicable tax
registrations. This integration uses Stripe Checkout/Billing/Tax, not a merchant-of-record
product. Adaptive currency conversion and promotion codes are disabled for these terms.

Enable the public webhook at **`https://gl3.dev/api/premium/webhook`** for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `invoice.paid`
- `charge.refunded`

The website forwards the raw body and Stripe signature unchanged. The store API verifies
the signature, re-fetches the invoice and subscription, and validates customer identity,
price IDs, currency and amount against the saved order. Full charge refunds remove the
refunded invoice's access period. Partial refunds do not revoke access. Subscription
status, cancellation and payment problems are read from Stripe when the buyer opens
account management; an unpaid invoice never extends the entitlement. A refund does not
itself cancel future subscription billing—cancel it in Stripe when appropriate.

Buyer-specific price IDs and renewal amounts are persisted for rate protection. Changing
a new-customer price later must not rewrite `premium_buyers` records or existing Stripe
subscription items. The website also validates the advertised pricing contract, so a
future price change requires a coordinated implementation and copy change.

### Resend and credentials

Set `RESEND_API_KEY` and `PREMIUM_EMAIL_FROM` to a sender in a verified Resend domain.
Set `PREMIUM_TOKEN_KEY` to 32 cryptographically random bytes encoded as 64 hex characters
(for example, generate it with `openssl rand -hex 32`). Keep the same key on every replica
and preserve it during deploys until all encrypted token deliveries have completed.

`PUBLIC_ORIGIN` must match the website's public origin, including scheme and port in
development. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, both price IDs and the
portal configuration ID. The API refuses partial Premium configuration. If none of the
Premium settings are present, registry functionality stays available and checkout
reports unavailable.

Each paid invoice is a durable email job. The worker retries failures with backoff and
uses `premium-invoice/<invoice-id>` as the Resend idempotency key. Resend deduplicates
requests for 24 hours; if a process dies after sending but before committing, a retry
beyond that window can send a duplicate email. No new token is minted for that retry.
Monitor `purchase email deferred` and `purchase email worker failed` logs and query
pending `premium_invoices` if mail delivery stalls. A provider accepting a message is
not proof that the recipient's inbox accepted it; monitor bounces in Resend as well.

Only new accounts receive a newly minted token. Tokens are hashed for authentication;
a separate AES-GCM encrypted copy is retained for on-screen claim and email delivery.
The browser's random checkout proof, not a Stripe Session ID, authorises the one-time
claim. After a successful email and claim the encrypted copy is removed, or after seven
days if already emailed. An undelivered token remains encrypted while the queue retries.
Never log request bodies, tokens, buyer emails, or encryption/API keys.

### Routes

| Method | Path | Body / purpose |
| --- | --- | --- |
| GET | `/v1/premium/price` | Validated annual pricing terms; no secret or provider configuration |
| POST | `/v1/premium/start` | `{orderId, claimSecret, email? , auth?: {username, token}}`; email for new buyers, verified credentials for existing accounts |
| POST | `/v1/premium/status` | `{orderId, claimSecret}`; fulfilment and paid-through date |
| POST | `/v1/premium/claim` | Same proof; show a new account's credentials once |
| POST | `/v1/premium/billing` | `{username, token}`; renewal eligibility and subscription status |
| POST | `/v1/premium/portal` | `{username, token}`; Stripe portal URL for that buyer only |
| POST | `/v1/premium/webhook` | Raw Stripe event with `Stripe-Signature` |
| POST | `/v1/account/profile` | `{username, token}`; identity and current Premium access |
| POST | `/v1/account/rotate-token` | `{username, token}`; replace only the presented token, revoke it atomically |

### Validation before launch

Run migrations as a separate deployment step, including `004_premium_orders.sql` and
`005_annual_premium.sql`. Do not start the new Premium worker before applying them.
The full test suite truncates its configured test database. It must never target a
shared development, staging or production database.

Database-free checks:

```bash
npm run build
npm test -- test/payments.test.ts test/env.test.ts
```

Then, once database work is available, run `npm test` against an explicitly isolated
`TEST_DATABASE_URL`. Exercise a full Stripe test-mode purchase, initial €69 invoice,
€49 annual renewal, failed payment, cancellation at period end, lapsed return at €49,
replayed/out-of-order webhooks, full refunds and Resend retries. Use a Stripe test clock
for renewal periods. Verify that expired access denies a tarball download while existing
local plugins still run and account sign-in works.

Release validation on 13 September 2026 passed all 131 API tests against the isolated
`gl3_store_premium_release_20260913` database, including annual renewals and €49 returning
checkout. The build also passes. No real Stripe payments or emails have been sent as
part of implementation, and production migrations still need to run on deployment.

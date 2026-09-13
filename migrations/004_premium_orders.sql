-- Checkout attempts are durable before contacting Stripe. The browser proof is
-- independent of Stripe's session ID, which is never enough to claim credentials.
create table premium_orders (
  id text primary key,
  claim_hash bytea not null,
  price_id text not null,
  amount integer not null,
  currency text not null,
  session_id text unique,
  payment_intent text unique,
  user_id text references users(id),
  email text,
  token_ciphertext text,
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  claimed_at timestamptz,
  refunded_at timestamptz,
  email_sent_at timestamptz,
  email_attempts integer not null default 0,
  email_retry_at timestamptz not null default now()
);
create index premium_orders_email_pending on premium_orders(email_retry_at)
  where fulfilled_at is not null and email_sent_at is null;

-- Refunds may arrive before checkout completion. Retain that fact independently
-- so delayed completion cannot restore a refunded licence.
create table premium_refunds (
  payment_intent text primary key,
  created_at timestamptz not null default now()
);

-- New annual contracts. Price identity stays on the buyer across cancellation
-- and resubscription so a future catalogue price cannot change their renewal.
create table premium_buyers (
  id text primary key,
  email text not null unique,
  user_id text unique references users(id),
  stripe_customer_id text unique,
  renewal_price_id text not null,
  renewal_amount integer not null,
  first_paid_at timestamptz
);
alter table premium_orders add column buyer_id text references premium_buyers(id);
alter table premium_orders add column initial_year boolean not null default true;
alter table premium_orders add column first_year_price_id text;
alter table premium_orders add column subscription_id text unique;

create table premium_invoices (
  id text primary key,
  order_id text not null references premium_orders(id),
  payment_intent text not null unique,
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount integer not null,
  refunded_at timestamptz,
  email_sent_at timestamptz,
  email_attempts integer not null default 0,
  email_retry_at timestamptz not null default now(),
  check (period_end > period_start)
);
create index premium_invoices_order on premium_invoices(order_id);

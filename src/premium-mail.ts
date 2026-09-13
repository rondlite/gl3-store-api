import type { Db } from './db.js';
import type { Logger } from './log.js';
import { unseal } from './secrets.js';
import { premiumErrorFields, PurchaseEmailError } from './premium-diagnostics.js';

export type PurchaseMail = { invoiceId: string; orderId: string; email: string; username: string;
  token: string | null; amount: number; paidUntil: string; renewalAmount: number };
export type SendPurchaseMail = (mail: PurchaseMail) => Promise<void>;
const euro = (amount: number) => new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(amount / 100);

export function createResendMailer(config: { apiKey: string; from: string; origin: string }): SendPurchaseMail {
  return async mail => {
    const credentials = mail.token
      ? `Username: ${mail.username}\nPassword (your npm token): ${mail.token}\n\nKeep this token private. You can replace it from your account page.`
      : 'Keep using your existing username and npm token.';
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `premium-invoice/${mail.invoiceId}` },
      body: JSON.stringify({ from: config.from, to: [mail.email], subject: 'Your GL3 Premium payment',
        text: `Thank you for your GL3 Premium payment of ${euro(mail.amount)}, including VAT.\n\nThis payment covers Premium access through ${mail.paidUntil}. Premium renews annually at ${euro(mail.renewalAmount)}, including VAT, unless you cancel. You can check your current subscription and cancel future renewals from your account.\n\n${credentials}\n\nTo install plugins:\n\nnpm config set @gl3-plugins:registry https://npm.gl3.dev\nnpm login --registry https://npm.gl3.dev --auth-type=legacy\nnpm install @gl3-plugins/market\n\nUse your gl3_ token as the password when npm asks.\n\nPremium support: https://discord.gg/6U8ezKE8T\nInstallation and upgrade help, plus engine and official plugin bug fixes. We aim to respond within 2 business days; no SLA or custom development. Support and registry access end when your subscription lapses. Your installed plugins keep running.\n\nAI is optional: plugins work with built-in templates or behaviour. You can connect your own OpenAI-compatible endpoint if you want model-generated content or decisions.\n\nManage your subscription: ${config.origin}/account.html\nOrder reference: ${mail.orderId}\n` }),
    });
    if (!response.ok) throw new PurchaseEmailError(response.status);
  };
}

// Each paid invoice is an outbox job, including recurring annual payments.
// SKIP LOCKED permits multiple replicas. The invoice idempotency key protects
// retries after a send succeeds but its database commit fails (Resend: 24h).
export async function deliverPurchaseMail(db: Db, key: Buffer, send: SendPurchaseMail, logger: Logger) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const mail = (await client.query<{
      id: string; order_id: string; amount: number; period_end: Date; email_attempts: number;
      email: string; username: string; token_ciphertext: string | null; email_sent_at: Date | null;
      claimed_at: Date | null; fulfilled_at: Date; renewal_amount: number;
    }>(`select i.id, i.order_id, i.amount, i.period_end, i.email_attempts,
      o.email, o.token_ciphertext, o.email_sent_at, o.claimed_at, o.fulfilled_at, u.username, b.renewal_amount
      from premium_invoices i join premium_orders o on o.id = i.order_id
      join premium_buyers b on b.id = o.buyer_id join users u on u.id = o.user_id
      where i.email_sent_at is null and i.refunded_at is null and i.email_retry_at <= now()
      order by i.period_start, i.id limit 1 for update of i, o skip locked`)).rows[0];
    if (mail) {
      try {
        await send({ invoiceId: mail.id, orderId: mail.order_id, amount: mail.amount,
          paidUntil: mail.period_end.toISOString(), renewalAmount: mail.renewal_amount,
          email: mail.email, username: mail.username,
          token: !mail.email_sent_at && mail.token_ciphertext ? unseal(mail.token_ciphertext, key, mail.order_id) : null });
        await client.query('update premium_invoices set email_sent_at = now() where id = $1', [mail.id]);
        await client.query(`update premium_orders set email_sent_at = coalesce(email_sent_at, now()), token_ciphertext =
          case when claimed_at is not null or fulfilled_at < now() - interval '7 days'
          then null else token_ciphertext end where id = $1`, [mail.order_id]);
      } catch (err) {
        logger.warn('purchase email deferred', { invoiceId: mail.id, ...premiumErrorFields(err) });
        await client.query(`update premium_invoices set email_attempts = email_attempts + 1,
          email_retry_at = now() + $2 * interval '1 second' where id = $1`,
        [mail.id, Math.min(3600, 30 * 2 ** Math.min(mail.email_attempts, 7))]);
      }
    }
    await client.query('commit');
    await client.query(`update premium_orders set token_ciphertext = null where email_sent_at is not null
      and fulfilled_at < now() - interval '7 days' and token_ciphertext is not null`);
  } catch (err) { await client.query('rollback'); throw err; }
  finally { client.release(); }
}

export function startPurchaseMail(db: Db, key: Buffer, send: SendPurchaseMail, logger: Logger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void>;
  async function tick() {
    try { await deliverPurchaseMail(db, key, send, logger); }
    catch (err) { logger.error('purchase email worker failed', premiumErrorFields(err)); }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, 2000);
  }
  running = tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}

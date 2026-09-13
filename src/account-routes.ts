import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from './db.js';
import { authenticate } from './service.js';
import { hashToken, newId, newToken } from './ids.js';

const credentials = z.object({ username: z.string().min(1).max(100), token: z.string().regex(/^gl3_[A-Za-z0-9_-]{43}$/) });

export function accountRoutes(db: Db) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 4096 }));
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.post('/profile', async (c) => {
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_credentials' }, 401);
    const user = await authenticate(db, parsed.data);
    if (!user) return c.json({ error: 'invalid_credentials' }, 401);
    const result = await db.query<{ premium: boolean }>(`select exists(select 1 from entitlements
      where user_id = $1 and package = '@gl3-plugins/*' and access = 'download'
      and revoked_at is null and (expires_at is null or expires_at > now())) as premium`, [user.userId]);
    return c.json({ username: user.username, premium: result.rows[0]!.premium });
  });
  app.post('/rotate-token', async (c) => {
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_credentials' }, 401);
    const client = await db.connect();
    try {
      await client.query('begin');
      const current = (await client.query<{ id: string; user_id: string; username: string }>(`select t.id, t.user_id, u.username
        from tokens t join users u on u.id = t.user_id where t.token_hash = $1 and u.username = $2
        and u.disabled_at is null and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
        for update of t, u`, [hashToken(parsed.data.token), parsed.data.username.toLowerCase()])).rows[0];
      if (!current) { await client.query('rollback'); return c.json({ error: 'invalid_credentials' }, 401); }
      const token = newToken();
      await client.query('insert into tokens (id, user_id, token_hash, name) values ($1, $2, $3, $4)',
        [newId('tok'), current.user_id, hashToken(token), 'Replaced from storefront']);
      await client.query('update tokens set revoked_at = now() where id = $1', [current.id]);
      await client.query('commit');
      return c.json({ username: current.username, token });
    } catch (err) { await client.query('rollback'); throw err; }
    finally { client.release(); }
  });
  return app;
}

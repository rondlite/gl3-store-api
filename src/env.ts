import { z } from 'zod';

/**
 * Default for REGISTRY_REFRESH_MS, also used by the app factory's
 * `catalogStaleMs` default so the two cannot silently disagree.
 */
export const DEFAULT_REGISTRY_REFRESH_MS = 900_000;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_FIRST_YEAR_PRICE_ID: z.string().startsWith('price_').optional(),
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().startsWith('bpc_').optional(),
  STRIPE_PREMIUM_PRICE_ID: z.string().startsWith('price_').optional(),
  PREMIUM_TOKEN_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  PREMIUM_EMAIL_FROM: z.string().email().optional(),
  PUBLIC_ORIGIN: z.string().url().default('https://gl3.dev')
    .transform(value => value.replace(/\/+$/, '')),

  // Shared secret the Verdaccio plugin sends as `Authorization: Bearer <key>`.
  // 32 chars is not a policy, it is the point below which a shared secret on a
  // public endpoint is guessable.
  INTERNAL_API_KEY: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // The website's catalogue reads package metadata from the registry using the
  // storefront service account. All four are optional: every deployment before
  // the catalogue existed sets none of them, and an unset registry simply means
  // the refresher never starts.
  REGISTRY_URL: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
  REGISTRY_USERNAME: z.string().min(1).optional(),
  REGISTRY_TOKEN: z.string().min(1).optional(),
  REGISTRY_REFRESH_MS: z.coerce.number().int().positive().default(DEFAULT_REGISTRY_REFRESH_MS),
}).superRefine((env, ctx) => {
  const keys = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PREMIUM_PRICE_ID',
    'STRIPE_FIRST_YEAR_PRICE_ID', 'STRIPE_PORTAL_CONFIGURATION_ID', 'PREMIUM_TOKEN_KEY', 'RESEND_API_KEY', 'PREMIUM_EMAIL_FROM'] as const;
  if (keys.some(key => env[key] !== undefined)) {
    for (const key of keys) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required when Premium is enabled' });
    }
  }
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${detail}`);
  }
  return parsed.data;
}

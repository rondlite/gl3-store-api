import { z } from 'zod';

/**
 * Default for REGISTRY_REFRESH_MS, also used by the app factory's
 * `catalogStaleMs` default so the two cannot silently disagree.
 */
export const DEFAULT_REGISTRY_REFRESH_MS = 900_000;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
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

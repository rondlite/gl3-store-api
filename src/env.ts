import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // Shared secret the Verdaccio plugin sends as `Authorization: Bearer <key>`.
  // 32 chars is not a policy, it is the point below which a shared secret on a
  // public endpoint is guessable.
  INTERNAL_API_KEY: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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

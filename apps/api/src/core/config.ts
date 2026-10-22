import { z } from 'zod';

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(4000),
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    AUTH_MODE: z.enum(['dev', 'jwks']).default('dev'),
    AUTH_DEV_SECRET: z.string().min(32).optional(),
    AUTH_JWKS_URL: z.string().url().optional(),
    AUTH_ISSUER: z.string().optional(),
    AUTH_AUDIENCE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'dev' && !env.AUTH_DEV_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_SECRET'], message: 'required when AUTH_MODE=dev' });
    }
    if (env.AUTH_MODE === 'jwks' && (!env.AUTH_JWKS_URL || !env.AUTH_ISSUER)) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_JWKS_URL'], message: 'AUTH_JWKS_URL and AUTH_ISSUER are required when AUTH_MODE=jwks' });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

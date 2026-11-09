import { z } from 'zod';

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(4000),
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    /** Which proxies' X-Forwarded-For to believe for client IPs (Express "trust proxy"). */
    TRUST_PROXY: z.string().default('loopback, uniquelocal'),
    /** password: built-in accounts. dev: anyone can sign in as any email (local only). jwks: an external identity provider. */
    AUTH_MODE: z.enum(['password', 'dev', 'jwks']).default('password'),
    /** Sends password-reset emails through Resend when set; otherwise only hub-made reset links work. */
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Ample POS <no-reply@example.com>'),
    /** Development only: print emails to the log instead of sending them. */
    EMAIL_DEV_LOG: z.enum(['true', 'false']).default('false'),
    AUTH_DEV_SECRET: z.string().min(32).optional(),
    AUTH_JWKS_URL: z.string().url().optional(),
    AUTH_ISSUER: z.string().optional(),
    AUTH_AUDIENCE: z.string().optional(),
    /** simulated: in-memory test processor. stripe: Stripe Terminal card-present payments. */
    PAYMENTS_PROVIDER: z.enum(['simulated', 'stripe']).default('simulated'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /** Connect account to charge on behalf of (per-business accounts come later). */
    STRIPE_ACCOUNT: z.string().optional(),
    /** simulated: subscriptions start at once with no charge. stripe: Checkout and the customer portal on Ample POS's Stripe account. */
    BILLING_PROVIDER: z.enum(['simulated', 'stripe']).default('simulated'),
    BILLING_STRIPE_SECRET_KEY: z.string().optional(),
    BILLING_STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /** 32 bytes, base64. Encrypts stored integration credentials; integrations are off without it. */
    SECRETS_KEY: z.string().optional(),
    /** Ample POS's Shopify app (Dev Dashboard). Enables "Connect with Shopify". */
    SHOPIFY_CLIENT_ID: z.string().optional(),
    SHOPIFY_CLIENT_SECRET: z.string().optional(),
    /** Where the admin hub runs; Shopify sends merchants back to <WEB_URL>/shopify/callback. */
    WEB_URL: z.string().url().default('http://localhost:3000'),
    /** Public base URL of this API, used for webhook addresses given to Shopify. */
    PUBLIC_API_URL: z.string().url().optional(),
    /** Run the outbox worker inside the API process (turn off when running it separately). */
    WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(2000),
    /** How often to reconcile each store connection (missed orders, stock drift). */
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(15 * 60_000),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_DEV_LOG === 'true' && process.env.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_DEV_LOG'], message: 'must not be used in production; set RESEND_API_KEY instead' });
    }
    if (env.AUTH_MODE === 'dev' && !env.AUTH_DEV_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_SECRET'], message: 'required when AUTH_MODE=dev' });
    }
    if (env.PAYMENTS_PROVIDER === 'stripe' && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['STRIPE_SECRET_KEY'], message: 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when PAYMENTS_PROVIDER=stripe' });
    }
    if (env.BILLING_PROVIDER === 'stripe' && (!env.BILLING_STRIPE_SECRET_KEY || !env.BILLING_STRIPE_WEBHOOK_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['BILLING_STRIPE_SECRET_KEY'], message: 'BILLING_STRIPE_SECRET_KEY and BILLING_STRIPE_WEBHOOK_SECRET are required when BILLING_PROVIDER=stripe' });
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

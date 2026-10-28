// Production entry point for a single container (Render): prepares the
// database, then runs the API on an internal port and the web app on $PORT.
// The web app proxies /api/* to the API, so devices and webhooks reach the
// API through the same public address.
import { spawn, spawnSync } from 'node:child_process';

const env = { ...process.env };
const publicUrl = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, '');
// Must match the /api rewrite in apps/web/next.config.ts.
const apiPort = '4000';

// The API connects as the restricted pos_app role on the same server as the admin URL.
if (!env.DATABASE_URL) {
  if (!env.ADMIN_DATABASE_URL || !env.APP_DB_PASSWORD) {
    console.error('Set DATABASE_URL, or ADMIN_DATABASE_URL and APP_DB_PASSWORD');
    process.exit(1);
  }
  const url = new URL(env.ADMIN_DATABASE_URL);
  url.username = 'pos_app';
  url.password = env.APP_DB_PASSWORD;
  env.DATABASE_URL = url.toString();
}

const setup = spawnSync('node', ['packages/db/dist/setup-cli.js'], { env, stdio: 'inherit' });
if (setup.status !== 0) process.exit(setup.status ?? 1);

const apiEnv = {
  ...env,
  PORT: apiPort,
  WEB_URL: env.WEB_URL ?? publicUrl,
  CORS_ORIGIN: env.CORS_ORIGIN ?? publicUrl,
  PUBLIC_API_URL: env.PUBLIC_API_URL ?? `${publicUrl}/api`,
};
const webEnv = {
  ...env,
  HOSTNAME: '0.0.0.0',
  PORT: env.PORT ?? '3000',
  API_URL: `http://127.0.0.1:${apiPort}`,
  PUBLIC_API_URL: apiEnv.PUBLIC_API_URL,
};

const children = [
  spawn('node', ['apps/api/dist/main.js'], { env: apiEnv, stdio: 'inherit' }),
  spawn('node', ['apps/web/.next/standalone/apps/web/server.js'], { env: webEnv, stdio: 'inherit' }),
];

// If either process dies, stop the other so the platform restarts the container.
let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 10_000).unref();
};
for (const c of children) c.on('exit', (code) => stop(code ?? 1));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop(0));

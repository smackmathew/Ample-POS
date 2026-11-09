import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DatabaseErrorFilter } from './core/errors.filter';
import type { AppConfig } from './core/config';

export function configureApp(app: INestApplication, config: AppConfig): void {
  // Client IPs (for sign-in rate limits) come from X-Forwarded-For set by trusted proxies.
  app.getHttpAdapter().getInstance().set('trust proxy', config.TRUST_PROXY.split(',').map((p) => p.trim()));
  app.enableCors({ origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()) });
  app.useGlobalFilters(new DatabaseErrorFilter(app.get(HttpAdapterHost).httpAdapter));
  app.enableShutdownHooks();
}

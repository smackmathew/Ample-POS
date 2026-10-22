import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DatabaseErrorFilter } from './core/errors.filter';
import type { AppConfig } from './core/config';

export function configureApp(app: INestApplication, config: AppConfig): void {
  app.enableCors({ origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()) });
  app.useGlobalFilters(new DatabaseErrorFilter(app.get(HttpAdapterHost).httpAdapter));
  app.enableShutdownHooks();
}

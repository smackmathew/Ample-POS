import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './core/config';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config));
  configureApp(app, config);
  await app.listen(config.PORT);
  console.log(`API listening on http://localhost:${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

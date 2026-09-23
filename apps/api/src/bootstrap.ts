import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { runMigrations } from './db/migrate.js';

/** Dipakai oleh main.ts dan test e2e. */
export async function createApp(config: AppConfig, opts: { migrate?: boolean; logger?: false } = {}): Promise<NestExpressApplication> {
  if (opts.migrate) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
    try {
      await runMigrations(pool);
    } finally {
      await pool.end();
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: opts.logger ?? ['log', 'warn', 'error'],
  });
  app.useBodyParser('json', { limit: '2mb' }); // riwayat tracking bisa ribuan event
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}

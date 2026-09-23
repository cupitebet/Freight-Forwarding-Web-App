import { createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
// Migrasi sebaiknya dijalankan sebagai langkah deploy terpisah (`npm run migrate`);
// MIGRATE_ON_START=true untuk lingkungan dev/single-instance.
const app = await createApp(config, { migrate: process.env.MIGRATE_ON_START === 'true' });
await app.listen(config.port);
console.log(`API berjalan di port ${config.port}`);

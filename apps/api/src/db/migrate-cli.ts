import pg from 'pg';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL belum diisi');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Diterapkan: ${applied.join(', ')}` : 'Tidak ada migrasi baru.');
} finally {
  await pool.end();
}

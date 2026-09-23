import pg from 'pg';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL belum diisi (cek file .env di root repo).');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Diterapkan: ${applied.join(', ')}` : 'Tidak ada migrasi baru.');
} catch (e) {
  const err = e as { code?: string; message: string };
  const where = new URL(url);
  const hints: Record<string, string> = {
    ECONNREFUSED: `PostgreSQL tidak bisa dihubungi di ${where.hostname}:${where.port || 5432}. Pastikan database berjalan (docker compose up -d db, atau service PostgreSQL di Windows).`,
    '28P01': 'Username/password database salah. Cek DATABASE_URL di .env.',
    '3D000': `Database "${where.pathname.slice(1)}" belum ada. Buat dulu: CREATE DATABASE ${where.pathname.slice(1)} OWNER ${where.username};`,
  };
  console.error(`Migrasi gagal: ${(err.code && hints[err.code]) ?? err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

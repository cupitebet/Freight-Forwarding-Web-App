import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** apps/api/migrations — sama dari src/ (tsc) maupun dist/src/ (runtime). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));
const LOCK_ID = 7_274_001; // advisory lock khusus migrasi

/**
 * Jalankan file *.sql yang belum pernah dijalankan, urut nama, masing-masing dalam transaksi.
 * Aman dijalankan paralel (advisory lock). Mengembalikan nama file yang baru diterapkan.
 */
export async function runMigrations(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(`${dir}/${file}`, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migrasi ${file} gagal: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

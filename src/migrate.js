import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';

const root = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(root, '..', 'db', 'migrations');

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    const seen = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (seen.rowCount) continue;
    const sql = await readFile(join(migrationDir, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied migration ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} catch (error) {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

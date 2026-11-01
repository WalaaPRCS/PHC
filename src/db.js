import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 15),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

export async function audit({ actorId = null, clinicRef = null, action, entityType = null, entityId = null, sourceSystem = null, requestId = null, details = {} }) {
  await pool.query(
    `INSERT INTO audit_events(actor_user_id, action, entity_type, entity_id, source_system, request_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [actorId, action, entityType, entityId, sourceSystem, requestId, JSON.stringify({ clinicRef, ...details })],
  );
}

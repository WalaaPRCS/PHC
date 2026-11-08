import { essentialMedicines } from './essential-medicines.js';

export async function seedEssentialMedicines(pool, syncNormalized) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['prcs-essential-medicines-v1']);
    const marker = await client.query("SELECT 1 FROM app_records WHERE resource='system_meta' AND record_id='essential-medicines-v1'");
    if (marker.rowCount) { await client.query('COMMIT'); return false; }
    for (const medicine of essentialMedicines) {
      await client.query(
        `INSERT INTO app_records(resource,record_id,clinic_ref,payload)
         VALUES('drug_catalog',$1,NULL,$2::jsonb)
         ON CONFLICT(resource,record_id) DO UPDATE SET payload=EXCLUDED.payload,version=app_records.version+1,updated_at=now()`,
        [medicine.id, JSON.stringify(medicine)],
      );
      try {
        await syncNormalized(client, 'drug_catalog', medicine, medicine.id);
      } catch (error) {
        throw new Error(`تعذر تجهيز الدواء ${medicine.code}: ${error.message}`, { cause: error });
      }
    }
    await client.query(
      "INSERT INTO app_records(resource,record_id,payload) VALUES('system_meta','essential-medicines-v1',jsonb_build_object('count',$1::int,'source','Essential Medicines Needs Medical Points')) ON CONFLICT DO NOTHING",
      [essentialMedicines.length],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

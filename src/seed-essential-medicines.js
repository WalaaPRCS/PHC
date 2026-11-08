import { essentialMedicines } from './essential-medicines.js';

export async function seedEssentialMedicines(pool, syncNormalized) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['prcs-essential-medicines-v1']);
    // Remove only the three pharmacy examples shown in the old demo catalog,
    // including their synthetic quantities and dispense record. Never touch
    // real stock or any other medicine records.
    const demoDrugIds = ['drug-demo-paracetamol', 'drug-demo-amoxicillin', 'drug-demo-ors'];
    const demoStockIds = ['stock-demo-paracetamol-ram', 'stock-demo-amoxicillin-ram', 'stock-demo-ors-nab'];
    await client.query("DELETE FROM dispensations WHERE source_record_id='dispense-demo-001'");
    await client.query("DELETE FROM pharmacy_stock WHERE source_record_id=ANY($1::text[])", [demoStockIds]);
    await client.query("DELETE FROM drug_catalog WHERE source_record_id=ANY($1::text[])", [demoDrugIds]);
    await client.query("DELETE FROM app_records WHERE (resource='dispenses' AND record_id='dispense-demo-001') OR (resource='pharmacy_stock' AND record_id=ANY($1::text[])) OR (resource='drug_catalog' AND record_id=ANY($2::text[]))", [demoStockIds, demoDrugIds]);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { essentialMedicines } from '../src/essential-medicines.js';
import { seedEssentialMedicines } from '../src/seed-essential-medicines.js';

test('essential medicines import contains 93 classified items with unique codes and nonnegative costs', () => {
  assert.equal(essentialMedicines.length, 93);
  assert.equal(new Set(essentialMedicines.map((item) => item.code)).size, essentialMedicines.length);
  assert.ok(essentialMedicines.every((item) => item.name && item.category && item.form && item.sourceUnit));
  assert.ok(essentialMedicines.every((item) => item.unitCostNis === null || (Number.isFinite(item.unitCostNis) && item.unitCostNis >= 0)));
  assert.ok(essentialMedicines.every((item) => !Object.hasOwn(item, 'quantity') && !Object.hasOwn(item, 'clinic')));
});

test('essential medicines seed runs once and never creates stock rows', async () => {
  let seeded = false;
  let catalogWrites = 0;
  let stockWrites = 0;
  const client = {
    async query(sql) {
      if (sql.includes("record_id='essential-medicines-v1'")) return { rowCount: seeded ? 1 : 0, rows: [] };
      if (sql.includes("VALUES('drug_catalog'")) catalogWrites += 1;
      if (sql.includes("VALUES('system_meta','essential-medicines-v1'")) seeded = true;
      if (sql.includes("VALUES('pharmacy_stock'")) stockWrites += 1;
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  let normalizedWrites = 0;
  const syncNormalized = async () => { normalizedWrites += 1; };

  assert.equal(await seedEssentialMedicines(pool, syncNormalized), true);
  assert.equal(await seedEssentialMedicines(pool, syncNormalized), false);
  assert.equal(catalogWrites, 93);
  assert.equal(normalizedWrites, 93);
  assert.equal(stockWrites, 0);
});

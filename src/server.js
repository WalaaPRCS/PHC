import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';
import { pool, audit } from './db.js';
import { hashPassword, verifyPassword, opaqueToken, tokenHash, encryptNationalId, decryptNationalId, hashNationalId } from './security.js';
import { seedDemoData } from './demo-data.js';
import { seedClinicMappingData } from './clinic-mapping-data.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const sessionDurationMs = 8 * 60 * 60 * 1000;
const maxBodyBytes = 1_000_000;
const stateKeys = {
  clinics: 'prcsDemoClinicsV1', staff: 'prcsDemoStaffV1', projects: 'prcsDemoProjectsV1',
  allocations: 'prcsDemoAllocationsV1', patients: 'prcsDemoPatientRecordsV1',
  immunizations: 'prcsDemoImmunizationsV1', visits: 'prcsDemoVisitsV1', queue: 'prcsDemoQueueV1',
  pharmacy_stock: 'prcsDemoPharmacyStockV1', dispenses: 'prcsDemoDispenseRecordsV1',
  drug_catalog: 'prcsDemoDrugCatalogV1', lab_orders: 'prcsDemoLabOrdersV1',
};
const writeRoles = {
  clinics: ['system_admin'], staff: ['system_admin', 'clinic_admin'], projects: ['system_admin'],
  allocations: ['system_admin'], patients: ['system_admin', 'clinic_admin', 'clinician', 'reception', 'pharmacist', 'lab_technician'],
  immunizations: ['system_admin', 'clinic_admin', 'clinician'], visits: ['system_admin', 'clinic_admin', 'clinician'],
  queue: ['system_admin', 'clinic_admin', 'reception'], pharmacy_stock: ['system_admin'],
  dispenses: ['system_admin', 'clinic_admin', 'pharmacist'], drug_catalog: ['system_admin'],
  lab_orders: ['system_admin', 'clinic_admin', 'clinician', 'lab_technician'],
};
const readRoles = {
  clinics: ['system_admin', 'clinic_admin', 'clinician', 'reception', 'pharmacist', 'lab_technician', 'viewer'],
  staff: ['system_admin', 'clinic_admin', 'clinician', 'reception', 'pharmacist', 'lab_technician', 'viewer'],
  projects: ['system_admin', 'clinic_admin', 'clinician', 'viewer'], allocations: ['system_admin', 'clinic_admin', 'clinician', 'viewer'],
  patients: ['system_admin', 'clinic_admin', 'clinician', 'reception', 'pharmacist', 'lab_technician', 'viewer'],
  immunizations: ['system_admin', 'clinic_admin', 'clinician', 'viewer'], visits: ['system_admin', 'clinic_admin', 'clinician', 'pharmacist', 'lab_technician', 'viewer'],
  queue: ['system_admin', 'clinic_admin', 'reception'], pharmacy_stock: ['system_admin', 'clinic_admin', 'pharmacist'],
  dispenses: ['system_admin', 'clinic_admin', 'pharmacist'], drug_catalog: ['system_admin', 'clinic_admin', 'pharmacist'],
  lab_orders: ['system_admin', 'clinic_admin', 'clinician', 'lab_technician', 'viewer'],
};
const authFailures = new Map();

function requiredEnv(name, min = 1) {
  const value = process.env[name];
  if (!value || value.length < min) throw new Error(`${name} must be set and at least ${min} characters`);
  return value;
}

function sessionHash(token) {
  return createHmac('sha256', requiredEnv('SESSION_SECRET', 32)).update(token).digest('hex');
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

async function readJson(req, maxBytes = maxBodyBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(new Error('حجم الطلب أكبر من المسموح'), { status: 413 });
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('صيغة JSON غير صحيحة'), { status: 400 }); }
}

async function currentUser(req) {
  const token = cookieValue(req.headers.cookie, 'phc_session');
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.role, u.active, s.token_hash
       FROM user_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active=true`, [sessionHash(token)],
  );
  if (!rows[0]) return null;
  const clinics = await pool.query('SELECT clinic_ref FROM user_clinic_refs WHERE user_id=$1 ORDER BY clinic_ref', [rows[0].id]);
  return { ...rows[0], clinicRefs: clinics.rows.map((row) => row.clinic_ref) };
}

async function currentIntegration(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!match) return null;
  const tokenDigest = tokenHash(match[1]);
  const { rows } = await pool.query(
    `SELECT c.id,c.client_id,c.name,t.scopes
       FROM integration_access_tokens t JOIN integration_clients c ON c.id=t.client_id
      WHERE t.token_hash=$1 AND t.expires_at>now() AND c.enabled=true`, [tokenDigest],
  );
  if (!rows[0]) return null;
  await pool.query('UPDATE integration_clients SET last_used_at=now() WHERE id=$1', [rows[0].id]);
  return { id: rows[0].id, clientId: rows[0].client_id, name: rows[0].name, scopes: rows[0].scopes };
}

function hasScope(integration, scope) {
  return integration?.scopes?.includes(scope) || integration?.scopes?.includes('*') || false;
}

function assertSameOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (new URL(origin).host !== host) {
    send(res, 403, { error: 'origin_not_allowed' });
    return false;
  }
  return true;
}

function normalizedClinicRef(record, clinics) {
  const raw = record?.clinicId ?? record?.clinic_id ?? record?.clinicCode ?? '';
  if (raw) return String(raw);
  const name = String(record?.clinic || '');
  return clinics.find((clinic) => clinic.id === name || clinic.name === name || clinic.code === name)?.id || '';
}

function filterPatientRecord(record, user, clinics) {
  if (user.role === 'system_admin') return record;
  const allowed = new Set(user.clinicRefs);
  const visits = Array.isArray(record.visits) ? record.visits : [];
  const own = visits.filter((visit) => allowed.has(normalizedClinicRef(visit, clinics)));
  const latestOther = visits.filter((visit) => !allowed.has(normalizedClinicRef(visit, clinics))).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  const homeClinicAllowed = allowed.has(normalizedClinicRef(record, clinics));
  if (!own.length && !latestOther && !homeClinicAllowed) return null;
  return { ...record, visits: own.sort((a, b) => new Date(b.date) - new Date(a.date)), latestOtherVisit: latestOther ? { id: latestOther.id, date: latestOther.date, clinic: latestOther.clinic, service: latestOther.service, status: latestOther.status } : null };
}

function canReadResource(user, resource) {
  return readRoles[resource]?.includes(user.role) || false;
}
function canWriteResource(user, resource) {
  return writeRoles[resource]?.includes(user.role) || false;
}

async function loadState(user) {
  const result = {};
  const clinicRes = await pool.query("SELECT record_id,payload FROM app_records WHERE resource='clinics'");
  const clinics = clinicRes.rows.map((row) => row.payload);
  for (const [resource, storageKey] of Object.entries(stateKeys)) {
    if (!canReadResource(user, resource)) { result[storageKey] = []; continue; }
    const { rows } = await pool.query('SELECT record_id, clinic_ref, payload FROM app_records WHERE resource=$1', [resource]);
    let visible = rows;
    if (user.role !== 'system_admin') {
    if (resource === 'patients') {
        visible = rows.filter((row) => {
          const ownVisit = (row.payload.visits || []).some((visit) => user.clinicRefs.includes(normalizedClinicRef(visit, clinics)));
          return user.clinicRefs.includes(String(row.clinic_ref || '')) || ownVisit;
        });
      } else if (resource === 'projects') {
        const allocations = (await pool.query('SELECT payload FROM app_records WHERE resource=$1', ['allocations'])).rows.map((r) => r.payload);
        const allowedProjects = new Set(allocations.filter((a) => user.clinicRefs.includes(String(a.clinicId))).map((a) => String(a.projectId)));
        visible = rows.filter((row) => allowedProjects.has(row.record_id));
      } else if (resource === 'drug_catalog') {
        visible = rows;
      } else {
        visible = rows.filter((row) => !row.clinic_ref || user.clinicRefs.includes(row.clinic_ref));
      }
    }
    let records = visible.map((row) => row.payload);
    if (resource === 'clinics' && user.role !== 'system_admin') records = records.filter((clinic) => user.clinicRefs.includes(String(clinic.id)));
    if (resource === 'patients' && user.role !== 'system_admin') records = records.map((item) => filterPatientRecord(item, user, clinics)).filter(Boolean);
    result[storageKey] = records;
  }
  return result;
}

async function syncNormalized(client, resource, payload, recordId) {
  if (resource === 'clinics') {
    const code = String(payload.code || recordId).slice(0, 120);
    await client.query(
      `INSERT INTO clinics(code,name,status,location,address,phone,metadata)
       VALUES($1,$2,$3,$4,$5,$6,jsonb_build_object('appRecordId',$7::text) || $8::jsonb)
       ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,location=EXCLUDED.location,
         address=EXCLUDED.address,phone=EXCLUDED.phone,metadata=clinics.metadata || EXCLUDED.metadata,updated_at=now()`,
      [code, payload.name || code, payload.status || 'active', payload.location || '', payload.address || '', payload.phone || '', recordId, JSON.stringify(payload.sourceMetadata || {})],
    );
    const clinic = await client.query('SELECT id FROM clinics WHERE code=$1', [code]);
    await client.query('DELETE FROM clinic_services WHERE clinic_id=$1', [clinic.rows[0].id]);
    for (const serviceName of payload.services || []) {
      await client.query('INSERT INTO clinic_services(clinic_id,service_id) SELECT $1,id FROM service_catalog WHERE name=$2 ON CONFLICT DO NOTHING', [clinic.rows[0].id, serviceName]);
    }
  }
  if (resource === 'patients') {
    const patientNumber = String(payload.fileNo || payload.patientNumber || recordId);
    const gender = payload.gender || null;
    await client.query(
      `INSERT INTO patients(patient_number,national_id_hash,national_id_ciphertext,full_name,date_of_birth,gender,phone,alternate_phone,address,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(patient_number) DO UPDATE SET national_id_hash=COALESCE(EXCLUDED.national_id_hash,patients.national_id_hash),
         national_id_ciphertext=COALESCE(EXCLUDED.national_id_ciphertext,patients.national_id_ciphertext),full_name=EXCLUDED.full_name,
         date_of_birth=EXCLUDED.date_of_birth,gender=EXCLUDED.gender,phone=EXCLUDED.phone,
         alternate_phone=EXCLUDED.alternate_phone,address=EXCLUDED.address,metadata=patients.metadata || EXCLUDED.metadata,updated_at=now()`,
      [patientNumber, payload.nationalId ? hashNationalId(payload.nationalId) : null, payload.nationalId ? encryptNationalId(payload.nationalId) : null, payload.name || 'مريض', payload.dateOfBirth || null, gender, payload.phone || null, payload.alternatePhone || null, payload.address || null,
        JSON.stringify({ fileNo: patientNumber, bloodType: payload.bloodType || null, nationality: payload.nationality || null, maritalStatus: payload.maritalStatus || null, emergencyContact: payload.emergencyContact || null })],
    );
    for (const visit of Array.isArray(payload.visits) ? payload.visits : []) {
      await upsertNormalizedVisit(client, patientNumber, visit);
      const normalized = [...(visit.referrals || []), ...(visit.referralDetails ? [visit.referralDetails] : [])];
      const typedVisit = await client.query('SELECT id FROM visits WHERE visit_number=$1', [`${patientNumber}:${String(visit.id || visit.date || '')}`]);
      for (const referral of normalized) {
        const sourceId = String(referral.id || `${visit.id}:${referral.type}:${referral.destination}`);
        if (typedVisit.rows[0]) await syncReferral(client, typedVisit.rows[0].id, referral, sourceId);
      }
    }
  }
  if (resource === 'visits') {
    const patientNumber = String(payload.fileNo || payload.patientNumber || '');
    const patient = await client.query('SELECT id FROM patients WHERE patient_number=$1', [patientNumber]);
    if (!patient.rows[0]) return;
    const visitId = await upsertNormalizedVisit(client, patientNumber, payload);
    if (visitId && payload.referralDetails) await syncReferral(client, visitId, payload.referralDetails, String(payload.referralDetails.id || `${recordId}:referral`));
    for (const referral of payload.referrals || []) if (visitId) await syncReferral(client, visitId, referral, String(referral.id || `${recordId}:${referral.type}:${referral.destination}`));
    for (const test of payload.labTests || []) if (visitId) await syncLabOrder(client, { ...test, fileNo: patientNumber, visitId: payload.id }, String(test.id || `${recordId}:lab:${test.testName}`));
    for (const vaccine of payload.immunizations || []) if (visitId) await syncImmunization(client, { ...vaccine, fileNo: patientNumber, visitId: payload.id }, String(vaccine.id || `${recordId}:vaccine`));
  }
  if (resource === 'staff') {
    const clinic = await client.query("SELECT id FROM clinics WHERE metadata->>'appRecordId'=$1 LIMIT 1", [String(payload.clinicId || '')]);
    if (!clinic.rows[0]) return;
    const specialty = await client.query('SELECT id FROM service_catalog WHERE name=$1', [payload.specialtyService || '']);
    await client.query(
      `INSERT INTO staff_members(source_record_id,clinic_id,external_code,display_name,job_title,specialty_service_id,phone,active,employment_type,employment_status,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(source_record_id) DO UPDATE SET clinic_id=EXCLUDED.clinic_id,external_code=EXCLUDED.external_code,
        display_name=EXCLUDED.display_name,job_title=EXCLUDED.job_title,specialty_service_id=EXCLUDED.specialty_service_id,
        phone=EXCLUDED.phone,active=EXCLUDED.active,employment_type=EXCLUDED.employment_type,
        employment_status=EXCLUDED.employment_status,metadata=EXCLUDED.metadata`,
      [recordId, clinic.rows[0].id, payload.employeeCode || null, payload.name || 'مقدم خدمة', payload.jobTitle || 'مقدم خدمة', specialty.rows[0]?.id || null, payload.phone || null, !['موقوف','موقوف مؤقتًا','إجازة','منتهي الخدمة'].includes(payload.status), payload.employmentType || 'غير محدد', payload.status === 'نشط' ? 'على رأس العمل' : payload.status === 'موقوف مؤقتًا' ? 'موقوف' : payload.status || 'على رأس العمل', JSON.stringify({ services: payload.services || [] })],
    );
    const staff = await client.query('SELECT id FROM staff_members WHERE source_record_id=$1', [recordId]);
    await client.query('DELETE FROM staff_services WHERE staff_id=$1', [staff.rows[0].id]);
    for (const serviceName of payload.services || []) {
      await client.query('INSERT INTO staff_services(staff_id,service_id) SELECT $1,id FROM service_catalog WHERE name=$2 ON CONFLICT DO NOTHING', [staff.rows[0].id, serviceName]);
    }
  }
  if (resource === 'projects') {
    const code = String(payload.code || recordId).slice(0, 120);
    await client.query(
      `INSERT INTO projects(source_record_id,code,name,donor,starts_on,ends_on,status,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(source_record_id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,donor=EXCLUDED.donor,
        starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,status=EXCLUDED.status,metadata=EXCLUDED.metadata`,
      [recordId, code, payload.name || code, payload.donor || null, payload.start || null, payload.end || null, payload.status || 'active', JSON.stringify({ description: payload.description || '' })],
    );
    const project = await client.query('SELECT id FROM projects WHERE source_record_id=$1', [recordId]);
    for (const service of payload.services || []) {
      const serviceId = await client.query('SELECT id FROM service_catalog WHERE name=$1', [service.name]);
      if (!serviceId.rows[0]) continue;
      await client.query('INSERT INTO project_services(project_id,service_id,goal) VALUES($1,$2,$3) ON CONFLICT(project_id,service_id) DO UPDATE SET goal=EXCLUDED.goal', [project.rows[0].id, serviceId.rows[0].id, service.goal || '']);
    }
    for (const indicator of payload.indicators || []) {
      const serviceId = await client.query('SELECT id FROM service_catalog WHERE name=$1', [indicator.service]);
      if (!serviceId.rows[0]) continue;
      const ps = await client.query('SELECT id FROM project_services WHERE project_id=$1 AND service_id=$2', [project.rows[0].id, serviceId.rows[0].id]);
      await client.query(
        `INSERT INTO project_indicators(source_record_id,project_service_id,code,name,unit,baseline,target,frequency)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(source_record_id) DO UPDATE SET project_service_id=EXCLUDED.project_service_id,code=EXCLUDED.code,
          name=EXCLUDED.name,unit=EXCLUDED.unit,baseline=EXCLUDED.baseline,target=EXCLUDED.target,frequency=EXCLUDED.frequency`,
        [String(indicator.id || `${recordId}:${indicator.service}:${indicator.name}`), ps.rows[0].id, String(indicator.id || ''), indicator.name, indicator.unit || 'count', Number(indicator.baseline || 0), Number(indicator.target || 0), indicator.frequency || null],
      );
    }
  }
  if (resource === 'allocations') {
    const clinic = await client.query("SELECT id FROM clinics WHERE metadata->>'appRecordId'=$1 LIMIT 1", [String(payload.clinicId || '')]);
    const project = await client.query('SELECT id FROM projects WHERE source_record_id=$1', [String(payload.projectId || '')]);
    const service = await client.query('SELECT id FROM service_catalog WHERE name=$1', [payload.service || '']);
    if (!clinic.rows[0] || !project.rows[0] || !service.rows[0]) return;
    const projectService = await client.query('SELECT id FROM project_services WHERE project_id=$1 AND service_id=$2', [project.rows[0].id, service.rows[0].id]);
    if (!projectService.rows[0]) return;
    const indicator = await client.query('SELECT id FROM project_indicators WHERE source_record_id=$1', [String(payload.indicatorId || '')]);
    await client.query(
      `INSERT INTO clinic_project_services(source_record_id,clinic_id,project_service_id,indicator_id,clinic_goal,target,coverage_percent,starts_on,ends_on,active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(source_record_id) DO UPDATE SET clinic_id=EXCLUDED.clinic_id,project_service_id=EXCLUDED.project_service_id,
        indicator_id=EXCLUDED.indicator_id,clinic_goal=EXCLUDED.clinic_goal,target=EXCLUDED.target,
        coverage_percent=EXCLUDED.coverage_percent,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,active=EXCLUDED.active`,
      [recordId, clinic.rows[0].id, projectService.rows[0].id, indicator.rows[0]?.id || null, payload.goal || null, Number(payload.target || 0), Number(payload.percent ?? 100), payload.start || null, payload.end || null, payload.active !== false],
    );
  }
  if (resource === 'drug_catalog') {
    await client.query(
      `INSERT INTO drug_catalog(source_record_id,code,generic_name,brand_name,strength,dosage_form,unit,aliases,metadata,active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,true)
       ON CONFLICT(source_record_id) DO UPDATE SET code=EXCLUDED.code,generic_name=EXCLUDED.generic_name,
        brand_name=EXCLUDED.brand_name,strength=EXCLUDED.strength,dosage_form=EXCLUDED.dosage_form,unit=EXCLUDED.unit,
        aliases=EXCLUDED.aliases,metadata=EXCLUDED.metadata,active=true`,
      [recordId, String(payload.code || recordId), payload.generic || payload.name || recordId, payload.name || null, payload.strength || null, payload.form || null, payload.sourceUnit || null, payload.aliases || [], JSON.stringify(payload)],
    );
  }
  if (resource === 'pharmacy_stock') {
    const clinic = await client.query("SELECT id FROM clinics WHERE metadata->>'appRecordId'=$1 OR name=$1 OR code=$1 ORDER BY CASE WHEN metadata->>'appRecordId'=$1 THEN 0 ELSE 1 END,created_at LIMIT 1", [String(payload.clinicId || payload.clinic || '')]);
    const drug = await client.query('SELECT id FROM drug_catalog WHERE source_record_id=$1', [String(payload.drugId || '')]);
    if (!clinic.rows[0] || !drug.rows[0]) return;
    await client.query(
      `INSERT INTO pharmacy_stock(source_record_id,clinic_id,drug_id,batch_number,expiry_date,quantity,unit_cost)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(source_record_id) DO UPDATE SET clinic_id=EXCLUDED.clinic_id,drug_id=EXCLUDED.drug_id,
        batch_number=EXCLUDED.batch_number,expiry_date=EXCLUDED.expiry_date,quantity=EXCLUDED.quantity,
        unit_cost=EXCLUDED.unit_cost,updated_at=now()`,
      [recordId, clinic.rows[0].id, drug.rows[0].id, payload.batch || null, payload.expiry || null, Number(payload.quantity || 0), payload.unitCostNis ?? null],
    );
  }
  if (resource === 'lab_orders') {
    const patientNumber = String(payload.fileNo || payload.patientNumber || '');
    const patient = await client.query('SELECT payload FROM app_records WHERE resource=$1 AND record_id=$2', ['patients', patientNumber]);
    const visit = (patient.rows[0]?.payload.visits || []).find((item) => item.id === payload.visitId);
    if (visit) {
      await upsertNormalizedVisit(client, patientNumber, visit);
      const visitNumber = `${patientNumber}:${payload.visitId}`;
      await syncLabOrder(client, { ...payload, visitNumber }, recordId);
    }
  }
  if (resource === 'immunizations') await syncImmunization(client, payload, recordId);
  if (resource === 'dispenses') await syncDispensation(client, payload, recordId);
  if (resource === 'patients') {
    const patient = await client.query('SELECT id FROM patients WHERE patient_number=$1', [String(payload.fileNo || payload.patientNumber || recordId)]);
    for (const visit of Array.isArray(payload.visits) ? payload.visits : []) {
      const visitId = await upsertNormalizedVisit(client, String(payload.fileNo || payload.patientNumber || recordId), visit);
      if (visitId) {
        const referrals = [...(visit.referrals || []), ...(visit.referralDetails ? [visit.referralDetails] : [])];
        for (const referral of referrals) await syncReferral(client, visitId, referral, String(referral.id || `${visit.id}:${referral.type}:${referral.destination}`));
      }
    }
  }
}

async function upsertNormalizedVisit(client, patientNumber, visit) {
  if (!patientNumber || !visit) return null;
  const patient = await client.query('SELECT id FROM patients WHERE patient_number=$1', [patientNumber]);
  const clinicName = String(visit.clinic || '');
  const clinic = await client.query("SELECT id FROM clinics WHERE metadata->>'appRecordId'=$1 OR name=$1 OR code=$1 ORDER BY CASE WHEN metadata->>'appRecordId'=$1 THEN 0 ELSE 1 END,created_at LIMIT 1", [String(visit.clinicId || clinicName)]);
  if (!patient.rows[0] || !clinic.rows[0]) return null;
  const service = await client.query('SELECT id FROM service_catalog WHERE name=$1', [visit.service || '']);
  const visitKey = `${patientNumber}:${String(visit.id || visit.date || randomUUID())}`.slice(0, 250);
  const result = await client.query(
    `INSERT INTO visits(visit_number,patient_id,clinic_id,service_id,occurred_at,status,chief_complaint,assessment,diagnosis,plan,vitals,clinical_data)
     VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
     ON CONFLICT(visit_number) DO UPDATE SET clinic_id=EXCLUDED.clinic_id,service_id=EXCLUDED.service_id,
      occurred_at=EXCLUDED.occurred_at,status=EXCLUDED.status,chief_complaint=EXCLUDED.chief_complaint,
      assessment=EXCLUDED.assessment,diagnosis=EXCLUDED.diagnosis,plan=EXCLUDED.plan,vitals=EXCLUDED.vitals,clinical_data=EXCLUDED.clinical_data
     RETURNING id`,
    [visitKey, patient.rows[0].id, clinic.rows[0].id, service.rows[0]?.id || null, visit.date || null, visit.status || 'completed', visit.complaint || null,
      visit.assessment || null, visit.diagnosis || null, visit.plan || null, JSON.stringify(visit.vitals || {}), JSON.stringify(visit)],
  );
  return result.rows[0].id;
}

async function syncLabOrder(client, data, recordId) {
  const patient = await client.query('SELECT id FROM patients WHERE patient_number=$1', [String(data.fileNo || '')]);
  const visitNumber = String(data.visitNumber || `${data.fileNo}:${data.visitId}`);
  const visit = patient.rows[0] ? await client.query('SELECT id FROM visits WHERE visit_number=$1', [visitNumber]) : { rows: [] };
  if (!visit.rows[0]) return;
  await client.query(
    `INSERT INTO lab_orders(source_record_id,visit_id,test_code,test_name,specimen,priority,status,result_value,result_unit,reference_range,result_notes,requested_at,resulted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::timestamptz,now()),$13)
     ON CONFLICT(source_record_id) DO UPDATE SET visit_id=EXCLUDED.visit_id,test_code=EXCLUDED.test_code,test_name=EXCLUDED.test_name,
      specimen=EXCLUDED.specimen,priority=EXCLUDED.priority,status=EXCLUDED.status,result_value=EXCLUDED.result_value,
      result_unit=EXCLUDED.result_unit,reference_range=EXCLUDED.reference_range,result_notes=EXCLUDED.result_notes,
      requested_at=EXCLUDED.requested_at,resulted_at=EXCLUDED.resulted_at`,
    [recordId, visit.rows[0].id, data.testCode || null, data.testName || 'تحليل', data.specimen || null, data.priority || 'routine', data.status || 'requested', data.resultValue || null, data.resultUnit || null, data.referenceRange || null, data.resultNotes || null, data.requestedAt || null, data.resultAt || null],
  );
}

async function syncImmunization(client, data, recordId) {
  const patient = await client.query('SELECT id FROM patients WHERE patient_number=$1', [String(data.fileNo || '')]);
  const clinic = await client.query("SELECT id FROM clinics WHERE metadata->>'appRecordId'=$1 OR name=$1 ORDER BY created_at LIMIT 1", [String(data.clinicId || data.clinic || '')]);
  if (!patient.rows[0] || !clinic.rows[0]) return;
  const doseVisit = data.visitId ? await client.query('SELECT id FROM visits WHERE visit_number=$1', [String(data.visitNumber || `${data.fileNo}:${data.visitId}`)]) : { rows: [] };
  await client.query(
    `INSERT INTO immunizations(source_record_id,patient_id,visit_id,clinic_id,vaccine_code,vaccine_name,dose,status,administered_at,due_at,batch_number,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT(source_record_id) DO UPDATE SET patient_id=EXCLUDED.patient_id,visit_id=EXCLUDED.visit_id,clinic_id=EXCLUDED.clinic_id,
      vaccine_code=EXCLUDED.vaccine_code,vaccine_name=EXCLUDED.vaccine_name,dose=EXCLUDED.dose,status=EXCLUDED.status,
      administered_at=EXCLUDED.administered_at,due_at=EXCLUDED.due_at,batch_number=EXCLUDED.batch_number,metadata=EXCLUDED.metadata`,
    [recordId, patient.rows[0].id, doseVisit.rows[0]?.id || null, clinic.rows[0].id, data.vaccineCode || null, data.vaccine || 'تطعيم', data.dose || 'غير محدد', data.status || 'مجدول', data.status === 'أُعطي' ? data.date || null : null, data.dueDate || null, data.batch || null, JSON.stringify(data)],
  );
}

async function syncReferral(client, visitId, data, recordId) {
  if (!data || !data.type || !data.destination) return;
  const visitUuid = typeof visitId === 'string' && /^[0-9a-f-]{36}$/i.test(visitId) ? visitId : '';
  if (!visitUuid) return;
  const service = await client.query('SELECT id FROM service_catalog WHERE name=$1', [data.targetService || '']);
  await client.query(
    `INSERT INTO referrals(source_record_id,visit_id,referral_type,destination,target_service_id,urgency,reason,status,follow_up_at,outcome)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT(source_record_id) DO UPDATE SET visit_id=EXCLUDED.visit_id,referral_type=EXCLUDED.referral_type,
      destination=EXCLUDED.destination,target_service_id=EXCLUDED.target_service_id,urgency=EXCLUDED.urgency,
      reason=EXCLUDED.reason,status=EXCLUDED.status,follow_up_at=EXCLUDED.follow_up_at,outcome=EXCLUDED.outcome`,
    [recordId, visitUuid, data.type, data.destination, service.rows[0]?.id || null, data.urgency || null, data.reason || '', data.status || 'open', data.followUpAt || null, JSON.stringify({ outcomeNotes: data.outcomeNotes || '' })],
  );
}

async function syncDispensation(client, data, recordId) {
  const stock = await client.query('SELECT id FROM pharmacy_stock WHERE source_record_id=$1', [String(data.stockId || '')]);
  const visit = await client.query('SELECT id FROM visits WHERE visit_number=$1', [`${data.fileNo}:${data.visitId}`]);
  if (!stock.rows[0] || !visit.rows[0]) return;
  await client.query(
    `INSERT INTO dispensations(source_record_id,visit_id,stock_id,quantity,dose,duration,instructions)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(source_record_id) DO UPDATE SET visit_id=EXCLUDED.visit_id,stock_id=EXCLUDED.stock_id,
      quantity=EXCLUDED.quantity,dose=EXCLUDED.dose,duration=EXCLUDED.duration,instructions=EXCLUDED.instructions`,
    [recordId, visit.rows[0].id, stock.rows[0].id, Number(data.quantity || 0), data.dose || null, data.duration || null, data.instructions || null],
  );
}

async function replaceResource(user, resource, body, req) {
  if (!stateKeys[resource] || !canWriteResource(user, resource)) {
    return { status: 403, payload: { error: 'resource_write_forbidden' } };
  }
  if (!Array.isArray(body.records) || body.records.length > 5000) {
    return { status: 400, payload: { error: 'records_must_be_an_array' } };
  }
  const clinics = (await pool.query("SELECT payload FROM app_records WHERE resource='clinics'")).rows.map((r) => r.payload);
  const allowed = new Set(user.clinicRefs);
  if (['clinics','projects','allocations','drug_catalog','pharmacy_stock'].includes(resource) && user.role !== 'system_admin') return { status: 403, payload: { error: 'system_admin_only' } };
  const incoming = body.records;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const record of incoming) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw Object.assign(new Error('invalid_record'), { status: 400 });
      const id = String(record.id || record.fileNo || record.code || record.employeeCode || '');
      if (!id || id.length > 250) throw Object.assign(new Error('record_id_required'), { status: 400 });
      const clinicRef = normalizedClinicRef(record, clinics) || null;
      if (resource === 'pharmacy_stock' && user.role !== 'system_admin') throw Object.assign(new Error('system_admin_only'), { status: 403 });
      if (user.role !== 'system_admin' && resource !== 'patients' && (!clinicRef || !allowed.has(clinicRef))) {
        throw Object.assign(new Error('record_outside_user_clinic'), { status: 403 });
      }
      let normalizedRecord = record;
      if (resource === 'clinics' && !record.sourceMetadata) {
        const priorClinic = await client.query('SELECT payload FROM app_records WHERE resource=$1 AND record_id=$2 FOR UPDATE', [resource, id]);
        if (priorClinic.rows[0]?.payload?.sourceMetadata) {
          const prior = priorClinic.rows[0].payload;
          normalizedRecord = {
            ...record,
            facilityType: record.facilityType || prior.facilityType,
            coordinates: record.coordinates || prior.coordinates,
            coLocated: record.coLocated ?? prior.coLocated,
            coLocatedHospital: record.coLocatedHospital || prior.coLocatedHospital,
            sourceMetadata: prior.sourceMetadata,
          };
        }
      }
      if (resource === 'patients' && user.role !== 'system_admin') {
        const existing = await client.query('SELECT clinic_ref,payload FROM app_records WHERE resource=$1 AND record_id=$2 FOR UPDATE', [resource, id]);
        const existingOwnVisit = (existing.rows[0]?.payload.visits || []).some((visit) => allowed.has(normalizedClinicRef(visit, clinics)));
        if ((!clinicRef || !allowed.has(clinicRef)) && !existingOwnVisit) throw Object.assign(new Error('patient_outside_user_clinic'), { status: 403 });
        const priorVisitIds = new Set((existing.rows[0]?.payload.visits || []).map((visit) => String(visit.id || visit.date)));
        for (const visit of Array.isArray(record.visits) ? record.visits : []) {
          const visitId = String(visit.id || visit.date || '');
          if (!allowed.has(normalizedClinicRef(visit, clinics)) && !priorVisitIds.has(visitId)) throw Object.assign(new Error('visit_outside_user_clinic'), { status: 403 });
        }
        if (existing.rows[0]) {
          const retainedVisits = (existing.rows[0].payload.visits || []).filter((visit) => !allowed.has(normalizedClinicRef(visit, clinics)));
          const merged = new Map(retainedVisits.map((visit) => [String(visit.id || visit.date), visit]));
          for (const visit of Array.isArray(record.visits) ? record.visits : []) {
            const visitId = String(visit.id || visit.date || '');
            if (allowed.has(normalizedClinicRef(visit, clinics)) || !merged.has(visitId)) merged.set(visitId, visit);
          }
          normalizedRecord = { ...record, visits: [...merged.values()].sort((a, b) => new Date(b.date) - new Date(a.date)) };
        }
      }
      if (user.role !== 'system_admin' && ['projects','allocations','clinics','drug_catalog','pharmacy_stock'].includes(resource)) {
        throw Object.assign(new Error('system_admin_only'), { status: 403 });
      }
      const patientId = resource === 'patients' ? null : await lookupPatientId(client, normalizedRecord, resource);
      const storedRecord = resource === 'patients' ? { ...normalizedRecord } : normalizedRecord;
      if (resource === 'patients') { delete storedRecord.nationalId; delete storedRecord.nationalTail; }
      if (resource === 'queue' && storedRecord.nationalId) {
        storedRecord.nationalIdMasked = `••••${String(storedRecord.nationalId).slice(-4)}`;
        delete storedRecord.nationalId;
      }
      await client.query(
        `INSERT INTO app_records(resource,record_id,clinic_ref,patient_id,payload,updated_by)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT(resource,record_id) DO UPDATE SET clinic_ref=EXCLUDED.clinic_ref,patient_id=EXCLUDED.patient_id,
           payload=EXCLUDED.payload,version=app_records.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [resource, id, clinicRef, patientId, JSON.stringify(storedRecord), user.id],
      );
      await syncNormalized(client, resource, normalizedRecord, id);
    }
    for (const rawId of ['patients','visits'].includes(resource) ? [] : Array.isArray(body.deletedIds) ? body.deletedIds.slice(0, 5000) : []) {
      const id = String(rawId);
      const existing = await client.query('SELECT clinic_ref FROM app_records WHERE resource=$1 AND record_id=$2 FOR UPDATE', [resource, id]);
      if (!existing.rowCount) continue;
      if (user.role !== 'system_admin' && !allowed.has(existing.rows[0].clinic_ref)) throw Object.assign(new Error('record_outside_user_clinic'), { status: 403 });
      if (resource === 'clinics' && user.role !== 'system_admin') throw Object.assign(new Error('system_admin_only'), { status: 403 });
      await client.query('DELETE FROM app_records WHERE resource=$1 AND record_id=$2', [resource, id]);
    }
    await audit({ actorId: user.id, action: 'records.replace', entityType: resource, requestId: req.id, details: { count: incoming.length } });
    await client.query('COMMIT');
    return { status: 200, payload: { ok: true, count: incoming.length } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lookupPatientId(client, record, resource) {
  const patientNumber = resource === 'patients' ? '' : String(record.fileNo || record.patientNumber || '');
  if (!patientNumber) return null;
  const { rows } = await client.query('SELECT id FROM patients WHERE patient_number=$1', [patientNumber]);
  return rows[0]?.id || null;
}

function loginRateLimited(ip) {
  const now = Date.now();
  const current = authFailures.get(ip) || { count: 0, until: now + 10 * 60_000 };
  if (current.until <= now) { current.count = 0; current.until = now + 10 * 60_000; }
  authFailures.set(ip, current);
  return current.count >= 10;
}

async function backfillImportedVaccinationVisits(actorId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT dose.record_id AS "recordId",dose.clinic_ref AS "clinicRef",dose.patient_id AS "patientId",
              COALESCE(NULLIF(dose.payload->>'fileNo',''),patient.record_id) AS "fileNo",
              dose.payload AS payload
         FROM app_records dose
         JOIN app_records patient ON patient.resource='patients'
          AND patient.record_id=COALESCE(NULLIF(dose.payload->>'fileNo',''),dose.record_id)
        WHERE dose.resource='immunizations'
          AND dose.payload->>'status'='أُعطي'
          AND dose.payload ? 'sourcePersonId'
          AND (
            NOT EXISTS (SELECT 1 FROM app_records visit
                         WHERE visit.resource='visits' AND visit.record_id=('vax-'||dose.record_id))
            OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(patient.payload->'visits','[]'::jsonb)) prior(visit)
               WHERE prior.visit->>'id'=('vax-'||dose.record_id)
            )
            OR EXISTS (SELECT 1 FROM immunizations normalized
                        WHERE normalized.source_record_id=dose.record_id AND normalized.visit_id IS NULL)
          )
        ORDER BY dose.record_id`,
    );
    if (!rows.length) { await client.query('COMMIT'); return 0; }
    const visits = rows.map((row) => {
      const dose = row.payload || {};
      const id = `vax-${row.recordId}`;
      const visit = {
        id, date: dose.date, clinic: dose.clinicNameAr || dose.clinic,
        clinicId: row.clinicRef || dose.clinicId, service: 'تطعيم', type: 'إعطاء جرعة تطعيم',
        status: 'مكتملة', provider: dose.provider || 'غير مسجل',
        complaint: `إعطاء ${dose.vaccine || 'تطعيم'} — ${dose.dose || 'جرعة غير محددة'}`,
        assessment: 'تم توثيق الجرعة ضمن سجل التطعيمات المستورد.',
        plan: 'متابعة جدول التطعيم الوطني حسب الجرعة التالية.',
        vitals: {}, medications: [], procedures: [`إعطاء ${dose.vaccine || 'تطعيم'} — ${dose.dose || 'جرعة غير محددة'}`],
        immunizationId: row.recordId, referral: 'لا توجد إحالة مسجلة.',
      };
      return {
        recordId: row.recordId, visitId: id, visitNumber: `${row.fileNo}:${id}`,
        fileNo: row.fileNo, patientId: row.patientId, clinicRef: row.clinicRef,
        date: String(dose.date || ''), status: visit.status,
        complaint: visit.complaint, assessment: visit.assessment, plan: visit.plan, payload: visit,
      };
    });
    const visitJson = JSON.stringify(visits);
    await client.query(
      `WITH source_rows AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           "visitId" text,"fileNo" text,"patientId" uuid,"clinicRef" text,"payload" jsonb
         )
       )
       INSERT INTO app_records(resource,record_id,clinic_ref,patient_id,payload,created_by,updated_by)
       SELECT 'visits',"visitId","clinicRef","patientId",
              jsonb_set("payload",'{fileNo}',to_jsonb("fileNo"),true),$2,$2
         FROM source_rows
       ON CONFLICT(resource,record_id) DO UPDATE SET clinic_ref=EXCLUDED.clinic_ref,
         patient_id=EXCLUDED.patient_id,payload=EXCLUDED.payload,version=app_records.version+1,
         updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [visitJson, actorId],
    );
    await client.query(
      `WITH source_rows AS (
         SELECT "fileNo","payload" FROM jsonb_to_recordset($1::jsonb)
           AS x("fileNo" text,"payload" jsonb)
       ), grouped AS (
         SELECT "fileNo",jsonb_agg("payload" ORDER BY "payload"->>'date',"payload"->>'id') AS visits
           FROM source_rows GROUP BY "fileNo"
       )
       UPDATE app_records patient
          SET payload=jsonb_set(
                patient.payload,'{visits}',
                COALESCE(patient.payload->'visits','[]'::jsonb) ||
                COALESCE((
                  SELECT jsonb_agg(incoming.visit)
                    FROM jsonb_array_elements(grouped.visits) AS incoming(visit)
                   WHERE NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(COALESCE(patient.payload->'visits','[]'::jsonb)) AS prior(visit)
                      WHERE prior.visit->>'id'=incoming.visit->>'id'
                   )
                ),'[]'::jsonb),true),
              version=version+1,updated_by=$2,updated_at=now()
         FROM grouped
        WHERE patient.resource='patients' AND patient.record_id=grouped."fileNo"`,
      [visitJson, actorId],
    );
    await client.query(
      `WITH source_rows AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           "recordId" text,"visitNumber" text,"fileNo" text,"clinicRef" text,"date" text,"status" text,
           "complaint" text,"assessment" text,"plan" text,"payload" jsonb
         )
       ), saved AS (
         INSERT INTO visits(visit_number,patient_id,clinic_id,service_id,occurred_at,status,
                            chief_complaint,assessment,plan,vitals,clinical_data)
         SELECT x."visitNumber",p.id,c.id,s.id,
                COALESCE(NULLIF(x."date",'')::timestamptz,now()),x."status",
                x."complaint",x."assessment",x."plan",'{}'::jsonb,x.payload
           FROM source_rows x
           JOIN patients p ON p.patient_number=x."fileNo"
           JOIN clinics c ON c.metadata->>'appRecordId'=x."clinicRef"
           LEFT JOIN service_catalog s ON s.name='تطعيم'
         ON CONFLICT(visit_number) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,
           status=EXCLUDED.status,chief_complaint=EXCLUDED.chief_complaint,
           assessment=EXCLUDED.assessment,plan=EXCLUDED.plan,clinical_data=EXCLUDED.clinical_data
         RETURNING id,visit_number
       )
       UPDATE immunizations normalized SET visit_id=saved.id
         FROM saved
        WHERE normalized.source_record_id IN (
          SELECT x."recordId" FROM source_rows x WHERE x."visitNumber"=saved.visit_number
        )`,
      [visitJson],
    );
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function handleApi(req, res, url) {
  if (!assertSameOrigin(req, res)) return;
  const requestId = randomUUID();
  req.id = requestId;
  if (req.method === 'GET' && url.pathname === '/api/v1/health') {
    await pool.query('SELECT 1');
    return send(res, 200, { status: 'ok', apiVersion: 'v1', database: 'connected', requestId });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/setup/status') {
    const { rows } = await pool.query('SELECT EXISTS(SELECT 1 FROM app_users) AS initialized');
    return send(res, 200, { needsSetup: !rows[0].initialized, requestId });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/setup/admin') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginRateLimited(ip)) return send(res, 429, { error: 'setup_rate_limited', requestId }, { 'Retry-After': '600' });
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    const password = String(body.password || '');
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || displayName.length < 2 || displayName.length > 150 || password.length < 12 || password.length > 256) {
      return send(res, 400, { error: 'invalid_initial_admin', requestId });
    }
    const passwordHash = await hashPassword(password);
    const token = opaqueToken();
    const expiresAt = new Date(Date.now() + sessionDurationMs);
    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(734921045)');
      const { rows } = await client.query('SELECT EXISTS(SELECT 1 FROM app_users) AS initialized');
      if (rows[0].initialized) {
        await client.query('ROLLBACK');
        return send(res, 409, { error: 'system_already_initialized', requestId });
      }
      created = await client.query(
        `INSERT INTO app_users(username,password_hash,display_name,role) VALUES($1,$2,$3,'system_admin') RETURNING id,username,display_name,role`,
        [username, passwordHash, displayName],
      );
      await client.query('INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [sessionHash(token), created.rows[0].id, expiresAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    authFailures.delete(ip);
    await audit({ actorId: created.rows[0].id, action: 'auth.first_admin.created', sourceSystem: 'web', requestId });
    return send(res, 201, { user: { id: created.rows[0].id, username: created.rows[0].username, displayName: created.rows[0].display_name, role: created.rows[0].role, clinicRefs: [] }, requestId }, {
      'Set-Cookie': `phc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionDurationMs / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginRateLimited(ip)) return send(res, 429, { error: 'login_rate_limited' }, { 'Retry-After': '600' });
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const { rows } = await pool.query('SELECT id,username,password_hash,display_name,role,active FROM app_users WHERE username=$1', [username]);
    const user = rows[0];
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      const item = authFailures.get(ip) || { count: 0, until: Date.now() + 10 * 60_000 };
      item.count += 1; authFailures.set(ip, item);
      await audit({ action: 'auth.login.failed', sourceSystem: 'web', requestId, details: { username } });
      return send(res, 401, { error: 'invalid_credentials', requestId });
    }
    authFailures.delete(ip);
    const token = opaqueToken();
    const expiresAt = new Date(Date.now() + sessionDurationMs);
    await pool.query('INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [sessionHash(token), user.id, expiresAt]);
    const clinics = await pool.query('SELECT clinic_ref FROM user_clinic_refs WHERE user_id=$1 ORDER BY clinic_ref', [user.id]);
    await audit({ actorId: user.id, action: 'auth.login.success', sourceSystem: 'web', requestId });
    return send(res, 200, { user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, clinicRefs: clinics.rows.map((c) => c.clinic_ref) }, requestId }, {
      'Set-Cookie': `phc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionDurationMs / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/integrations/token') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginRateLimited(ip)) return send(res, 429, { error: 'integration_auth_rate_limited', requestId }, { 'Retry-After': '600' });
    const body = await readJson(req);
    const clientId = String(body.clientId || '').trim();
    const clientSecret = String(body.clientSecret || '');
    const result = await pool.query('SELECT id,client_id,secret_hash,scopes FROM integration_clients WHERE client_id=$1 AND enabled=true', [clientId]);
    if (!result.rows[0] || !(await verifyPassword(clientSecret, result.rows[0].secret_hash))) {
      const failure = authFailures.get(ip) || { count: 0, until: Date.now() + 10 * 60_000 };
      failure.count += 1; authFailures.set(ip, failure);
      await audit({ action: 'integration.token.failed', sourceSystem: clientId.slice(0, 100), requestId });
      return send(res, 401, { error: 'invalid_client_credentials', requestId });
    }
    authFailures.delete(ip);
    const accessToken = opaqueToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query('INSERT INTO integration_access_tokens(token_hash,client_id,scopes,expires_at) VALUES($1,$2,$3,$4)', [tokenHash(accessToken), result.rows[0].id, result.rows[0].scopes, expiresAt]);
    await audit({ action: 'integration.token.issued', sourceSystem: clientId, requestId });
    return send(res, 200, { accessToken, tokenType: 'Bearer', expiresIn: 3600, scopes: result.rows[0].scopes, requestId }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
    const token = cookieValue(req.headers.cookie, 'phc_session');
    if (token) await pool.query('DELETE FROM user_sessions WHERE token_hash=$1', [sessionHash(token)]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'phc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }
  const user = await currentUser(req);
  const integration = await currentIntegration(req);
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/session') {
    if (!user) return send(res, 401, { error: 'authentication_required', requestId });
    delete user.token_hash;
    return send(res, 200, { user, requestId });
  }
  if (!user && !integration) return send(res, 401, { error: 'authentication_required', requestId });
  if (req.method === 'GET' && url.pathname === '/api/v1/state') {
    if (!user) return send(res, 403, { error: 'human_session_required', requestId });
    if (user.role === 'system_admin') {
      try {
        if (await seedDemoData(pool, syncNormalized)) console.log('Loaded clearly labeled demo records during admin state load');
      } catch (error) {
        console.error('Demo data retry failed:', error.message);
      }
      try {
        if (await seedClinicMappingData(pool, syncNormalized)) console.log('Imported mapped PRCS clinics during admin state load');
      } catch (error) {
        console.error('Clinic mapping import retry failed:', error.message);
      }
    }
    if (user.role === 'system_admin') {
      try {
        const repairedVaccinationVisits = await backfillImportedVaccinationVisits(user.id);
        if (repairedVaccinationVisits) console.log(`Linked ${repairedVaccinationVisits} archived vaccination doses to patient visits`);
      } catch (error) {
        console.error('Vaccination visit backfill failed; state loading will continue:', error.message);
      }
    }
    return send(res, 200, await loadState(user));
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/immunizations/archive-import') {
    if (!user || user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required', requestId });
    const body = await readJson(req, 16 * 1024 * 1024);
    if (body.format !== 'PRCS-PHC-PATIENT-ARCHIVE-IMPORT' || body.version !== 1 ||
        !Array.isArray(body.patients) || !Array.isArray(body.immunizations) ||
        body.patients.length < 1 || body.patients.length > 5000 ||
        body.immunizations.length > 20000) {
      return send(res, 400, { error: 'invalid_vaccination_archive_package', requestId });
    }
    const source = body.source || {};
    const clinicCode = String(source.clinicCode || '').trim();
    if (clinicCode !== 'PRCS-PHC-MAP-005') return send(res, 400, { error: 'archive_clinic_must_be_al_quds', requestId });
    const clinicResult = await pool.query(
      "SELECT record_id,payload FROM app_records WHERE resource='clinics' AND (record_id=$1 OR payload->>'code'=$2) ORDER BY CASE WHEN record_id=$1 THEN 0 ELSE 1 END LIMIT 1",
      [String(source.clinicId || 'clinic-map-2026-005'), clinicCode],
    );
    if (!clinicResult.rows[0]) return send(res, 400, { error: 'al_quds_clinic_not_configured', requestId });
    const clinic = clinicResult.rows[0];
    const archivePatients = [];
    const patientIds = new Set();
    for (const [index, patient] of body.patients.entries()) {
      const nationalId = String(patient?.nationalId || patient?.sourcePersonId || '').replace(/[^0-9]/g, '');
      const name = String(patient?.name || '').trim();
      const dateOfBirth = String(patient?.dateOfBirth || '').trim();
      if (!/^\d{6,20}$/.test(nationalId) || !name || name.length > 250 ||
          (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth))) {
        return send(res, 400, { error: 'invalid_archive_patient', row: index + 1, requestId });
      }
      if (patientIds.has(nationalId)) return send(res, 400, { error: 'duplicate_archive_national_id', row: index + 1, requestId });
      patientIds.add(nationalId);
      archivePatients.push({ source: patient, nationalId, name, dateOfBirth });
    }
    const archiveImmunizations = [];
    const sourceIds = new Set();
    for (const [index, dose] of body.immunizations.entries()) {
      const sourceRecordId = String(dose?.sourceRecordId || '').trim();
      const nationalId = String(dose?.nationalId || dose?.sourcePersonId || '').replace(/[^0-9]/g, '');
      const date = String(dose?.date || '').trim();
      if (!sourceRecordId || sourceRecordId.length > 200 || !patientIds.has(nationalId) ||
          !String(dose?.vaccine || '').trim() || !String(dose?.dose || '').trim() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return send(res, 400, { error: 'invalid_archive_immunization', row: index + 1, requestId });
      }
      if (sourceIds.has(sourceRecordId)) return send(res, 400, { error: 'duplicate_archive_source_record', row: index + 1, requestId });
      sourceIds.add(sourceRecordId);
      archiveImmunizations.push({ ...dose, sourceRecordId, nationalId, date });
    }
    const client = await pool.connect();
    let createdPatients = 0;
    let matchedPatients = 0;
    let importedDoses = 0;
    let skippedDoses = 0;
    let importStage = 'starting';
    try {
      await client.query('BEGIN');
      importStage = 'patient_records';
      const fileNoByNationalId = new Map();
      const patientIdByNationalId = new Map();
      for (const [patientIndex, entry] of archivePatients.entries()) {
        importStage = `patient_${patientIndex + 1}_of_${archivePatients.length}`;
        const identityHash = hashNationalId(entry.nationalId);
        const existing = await client.query(
          'SELECT patient_number,full_name,date_of_birth,gender,phone,alternate_phone,address FROM patients WHERE national_id_hash=$1 FOR UPDATE',
          [identityHash],
        );
        let fileNo = existing.rows[0]?.patient_number || '';
        let current = null;
        let patientClinicRef = clinic.record_id;
        if (fileNo) {
          const record = await client.query(
            "SELECT payload,clinic_ref FROM app_records WHERE resource='patients' AND record_id=$1 FOR UPDATE",
            [fileNo],
          );
          current = record.rows[0]?.payload || null;
          patientClinicRef = record.rows[0]?.clinic_ref || current?.clinicId || clinic.record_id;
          if (!current) {
            const row = existing.rows[0];
            current = {
              id: fileNo, fileNo, name: row.full_name || entry.name,
              dateOfBirth: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : entry.dateOfBirth,
              gender: row.gender || '', phone: row.phone || '', alternatePhone: row.alternate_phone || '',
              address: row.address || '', visits: [],
            };
          }
          matchedPatients += 1;
        } else {
          fileNo = 'PR-' + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
          current = { id: fileNo, fileNo, name: entry.name, dateOfBirth: entry.dateOfBirth, gender: '', phone: '', alternatePhone: '', address: '', visits: [] };
          createdPatients += 1;
        }
        const source = entry.source;
        const merged = {
          ...current,
          id: fileNo,
          fileNo,
          name: current.name || entry.name,
          dateOfBirth: current.dateOfBirth || entry.dateOfBirth,
          gender: current.gender || source.gender || '',
          nationality: current.nationality || source.nationality || '',
          maritalStatus: current.maritalStatus || source.maritalStatus || '',
          bloodType: current.bloodType || source.bloodType || '',
          phone: current.phone || source.phone || '',
          alternatePhone: current.alternatePhone || source.alternatePhone || '',
          address: current.address || source.address || '',
          nameParts: current.nameParts || source.nameParts || {},
          namePartsReviewRequired: current.namePartsReviewRequired ?? Boolean(source.namePartsReviewRequired),
          clinic: current.clinic || clinic.payload.name,
          clinicId: current.clinicId || clinic.record_id,
          visits: Array.isArray(current.visits) ? current.visits : [],
          archiveSource: { system: 'vaccinations_inquiries', clinicCode, personIdHash: identityHash },
          nationalId: entry.nationalId,
          nationalTail: entry.nationalId.slice(-4),
        };
        await syncNormalized(client, 'patients', merged, fileNo);
        const typed = await client.query('SELECT id FROM patients WHERE patient_number=$1', [fileNo]);
        if (!typed.rows[0]) throw new Error('patient_normalization_failed');
        const stored = { ...merged };
        delete stored.nationalId;
        delete stored.nationalTail;
        await client.query(
          `INSERT INTO app_records(resource,record_id,clinic_ref,patient_id,payload,created_by,updated_by)
           VALUES('patients',$1,$2,$3,$4::jsonb,$5,$5)
           ON CONFLICT(resource,record_id) DO UPDATE SET patient_id=EXCLUDED.patient_id,
             payload=EXCLUDED.payload,version=app_records.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [fileNo, patientClinicRef, typed.rows[0].id, JSON.stringify(stored), user.id],
        );
        fileNoByNationalId.set(entry.nationalId, fileNo);
        patientIdByNationalId.set(entry.nationalId, typed.rows[0].id);
      }
      importStage = 'prepare_vaccination_rows';
      const vaccineRows = archiveImmunizations.map((dose) => {
        const fileNo = fileNoByNationalId.get(dose.nationalId);
        const patientId = patientIdByNationalId.get(dose.nationalId);
        if (!fileNo || !patientId) throw new Error('archive_patient_mapping_missing');
        const record = {
          id: dose.sourceRecordId,
          fileNo,
          vaccine: String(dose.vaccine).trim(),
          vaccineCode: String(dose.vaccineCode || ''),
          dose: String(dose.dose).trim(),
          status: 'أُعطي',
          date: dose.date,
          dueDate: '',
          batch: '',
          provider: '',
          notes: '',
          clinic: clinic.payload.name,
          clinicNameAr: 'عيادة القدس',
          clinicId: clinic.record_id,
          sourceArchive: source.fileName || 'vaccinations_inquiries',
          sourcePersonId: dose.sourcePersonId || dose.nationalId,
        };
        return { recordId: dose.sourceRecordId, patientId, payload: record };
      });
      importStage = 'insert_vaccination_records';
      const insertedVaccines = await client.query(
        `WITH source_rows AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("recordId" text,"patientId" uuid,payload jsonb)
         )
         INSERT INTO app_records(resource,record_id,clinic_ref,patient_id,payload,created_by,updated_by)
         SELECT 'immunizations',"recordId",$2,"patientId",payload,$3,$3 FROM source_rows
         ON CONFLICT(resource,record_id) DO NOTHING
         RETURNING record_id`,
        [JSON.stringify(vaccineRows), clinic.record_id, user.id],
      );
      importedDoses = insertedVaccines.rowCount;
      skippedDoses = vaccineRows.length - importedDoses;
      const sourceRecordIds = vaccineRows.map((row) => row.recordId);
      importStage = 'normalize_vaccination_records';
      if (sourceRecordIds.length) {
        await client.query(
          `INSERT INTO immunizations(source_record_id,patient_id,visit_id,clinic_id,vaccine_code,vaccine_name,dose,status,administered_at,due_at,batch_number,metadata)
           SELECT r.record_id,p.id,NULL,c.id,NULLIF(r.payload->>'vaccineCode',''),
             COALESCE(NULLIF(r.payload->>'vaccine',''),'تطعيم'),
             COALESCE(NULLIF(r.payload->>'dose',''),'غير محدد'),
             COALESCE(NULLIF(r.payload->>'status',''),'مجدول'),
             CASE WHEN r.payload->>'status'='أُعطي' THEN NULLIF(r.payload->>'date','')::timestamptz ELSE NULL END,
             NULLIF(r.payload->>'dueDate','')::timestamptz,NULLIF(r.payload->>'batch',''),r.payload
           FROM app_records r
           JOIN patients p ON p.patient_number=r.payload->>'fileNo'
           JOIN clinics c ON c.metadata->>'appRecordId'=$2
           WHERE r.resource='immunizations' AND r.record_id=ANY($1::text[])
           ON CONFLICT(source_record_id) DO NOTHING`,
          [sourceRecordIds, clinic.record_id],
        );
      }
      const vaccinationVisits = vaccineRows.map((row) => {
        const dose = row.payload;
        const visitId = `vax-${row.recordId}`;
        const visit = {
          id: visitId, date: dose.date, clinic: dose.clinicNameAr || dose.clinic,
          clinicId: clinic.record_id, service: 'تطعيم', type: 'إعطاء جرعة تطعيم',
          status: 'مكتملة', provider: dose.provider || 'غير مسجل',
          complaint: `إعطاء ${dose.vaccine} — ${dose.dose}`,
          assessment: 'تم توثيق الجرعة ضمن سجل التطعيمات المستورد.',
          plan: 'متابعة جدول التطعيم الوطني حسب الجرعة التالية.',
          vitals: {}, medications: [], procedures: [`إعطاء ${dose.vaccine} — ${dose.dose}`],
          immunizationId: row.recordId, referral: 'لا توجد إحالة مسجلة.',
        };
        return {
          recordId: row.recordId, visitId, visitNumber: `${dose.fileNo}:${visitId}`,
          fileNo: dose.fileNo, patientId: row.patientId, clinicRef: clinic.record_id,
          date: dose.date, status: visit.status, complaint: visit.complaint,
          assessment: visit.assessment, plan: visit.plan, payload: visit,
        };
      });
      importStage = 'create_vaccination_visits';
      if (vaccinationVisits.length) {
        const visitJson = JSON.stringify(vaccinationVisits);
        await client.query(
          `WITH source_rows AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
               "visitId" text,"visitNumber" text,"fileNo" text,"patientId" uuid,"clinicRef" text,
               "date" text,"status" text,"complaint" text,"assessment" text,"plan" text,"payload" jsonb
             )
           )
           INSERT INTO app_records(resource,record_id,clinic_ref,patient_id,payload,created_by,updated_by)
           SELECT 'visits',"visitId","clinicRef","patientId",
                  jsonb_set("payload",'{fileNo}',to_jsonb("fileNo"),true),$2,$2
             FROM source_rows
           ON CONFLICT(resource,record_id) DO UPDATE SET clinic_ref=EXCLUDED.clinic_ref,
             patient_id=EXCLUDED.patient_id,payload=EXCLUDED.payload,version=app_records.version+1,
             updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [visitJson, user.id],
        );
        await client.query(
          `WITH source_rows AS (
             SELECT "fileNo","payload" FROM jsonb_to_recordset($1::jsonb)
               AS x("fileNo" text,"payload" jsonb)
           ), grouped AS (
             SELECT "fileNo",jsonb_agg("payload" ORDER BY "payload"->>'date',"payload"->>'id') AS visits
               FROM source_rows GROUP BY "fileNo"
           )
           UPDATE app_records patient
              SET payload=jsonb_set(
                    patient.payload,'{visits}',
                    COALESCE(patient.payload->'visits','[]'::jsonb) ||
                    COALESCE((
                      SELECT jsonb_agg(incoming.visit)
                        FROM jsonb_array_elements(grouped.visits) AS incoming(visit)
                       WHERE NOT EXISTS (
                         SELECT 1 FROM jsonb_array_elements(COALESCE(patient.payload->'visits','[]'::jsonb)) AS prior(visit)
                          WHERE prior.visit->>'id'=incoming.visit->>'id'
                       )
                    ),'[]'::jsonb),true),
                  version=version+1,updated_by=$2,updated_at=now()
             FROM grouped
            WHERE patient.resource='patients' AND patient.record_id=grouped."fileNo"`,
          [visitJson, user.id],
        );
        await client.query(
          `WITH source_rows AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
               "recordId" text,"visitNumber" text,"fileNo" text,"patientId" uuid,"date" text,
               "status" text,"complaint" text,"assessment" text,"plan" text,"payload" jsonb
             )
           ), saved AS (
             INSERT INTO visits(visit_number,patient_id,clinic_id,service_id,occurred_at,status,
                                chief_complaint,assessment,plan,vitals,clinical_data)
             SELECT x."visitNumber",p.id,c.id,s.id,
                    COALESCE(NULLIF(x."date",'')::timestamptz,now()),x."status",
                    x."complaint",x."assessment",x."plan",'{}'::jsonb,x.payload
               FROM source_rows x
               JOIN patients p ON p.patient_number=x."fileNo"
               JOIN clinics c ON c.metadata->>'appRecordId'=$2
               LEFT JOIN service_catalog s ON s.name='تطعيم'
             ON CONFLICT(visit_number) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,
               status=EXCLUDED.status,chief_complaint=EXCLUDED.chief_complaint,
               assessment=EXCLUDED.assessment,plan=EXCLUDED.plan,clinical_data=EXCLUDED.clinical_data
             RETURNING id,visit_number
           )
           UPDATE immunizations i SET visit_id=v.id
             FROM saved v
            WHERE i.source_record_id IN (
              SELECT x."recordId" FROM source_rows x WHERE x."visitNumber"=v.visit_number
            )`,
          [visitJson, clinic.record_id],
        );
      }
      importStage = 'audit';
      await audit({
        actorId: user.id, clinicRef: clinic.record_id, action: 'immunizations.archive_import',
        entityType: 'vaccination_archive', entityId: clinicCode, requestId,
        details: { patientsInFile: archivePatients.length, createdPatients, matchedPatients, importedDoses, skippedDoses },
      });
      importStage = 'commit';
      await client.query('COMMIT');
      return send(res, 200, { ok: true, clinicName: clinic.payload.name, clinicNameAr: 'عيادة القدس', patientsInFile: archivePatients.length, createdPatients, matchedPatients, importedDoses, skippedDoses, requestId });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Vaccination archive import failed', { requestId, stage: importStage, code: error.code || '', constraint: error.constraint || '', message: error.message });
      return send(res, 500, { error: 'archive_import_failed', requestId, stage: importStage, code: error.code || '' });
    } finally {
      client.release();
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/clinics/import') {
    if (!user || user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required', requestId });
    const body = await readJson(req);
    const sourceRecords = Array.isArray(body) ? body : body && typeof body === 'object' ? body.records : null;
    if (!Array.isArray(sourceRecords) || sourceRecords.length < 1 || sourceRecords.length > 500) {
      return send(res, 400, { error: 'clinic_records_must_be_an_array', requestId });
    }
    const canonicalServices = [
      ['general-medicine', 'طب عام'], ['nursing', 'تمريض'], ['nutrition', 'تغذية'],
      ['vaccination', 'تطعيم'], ['maternal-care', 'رعاية أمومة'], ['child-care', 'رعاية طفل'],
      ['mental-health', 'صحة نفسية'], ['dental', 'صحة فم وأسنان'], ['laboratory', 'مختبر'],
      ['radiology', 'أشعة'], ['pharmacy', 'صيدلية'], ['health-education', 'تثقيف صحي'],
    ];
    const serviceRows = await pool.query('SELECT name FROM service_catalog WHERE active=true');
    const validServices = new Set([...serviceRows.rows.map((row) => row.name), ...canonicalServices.map(([, name]) => name)]);
    const records = [];
    const seenCodes = new Set();
    const seenIds = new Set();
    for (const [index, source] of sourceRecords.entries()) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return send(res, 400, { error: 'invalid_clinic_record', row: index + 1, requestId });
      const code = String(source.code || '').trim();
      const name = String(source.name || '').trim();
      const id = String(source.id || code).trim();
      const services = Array.isArray(source.services) ? [...new Set(source.services.map((value) => String(value).trim()).filter(Boolean))] : [];
      const unknownServices = services.filter((service) => !validServices.has(service));
      if (!code || code.length > 120 || !id || id.length > 250 || !name || name.length > 200 || !services.length) {
        return send(res, 400, { error: 'invalid_clinic_data_or_service', row: index + 1, requestId });
      }
      if (unknownServices.length) return send(res, 400, { error: 'unknown_clinic_services', row: index + 1, services: unknownServices, requestId });
      if (seenCodes.has(code)) return send(res, 400, { error: 'duplicate_clinic_code', row: index + 1, requestId });
      if (seenIds.has(id)) return send(res, 400, { error: 'duplicate_clinic_id', row: index + 1, requestId });
      seenCodes.add(code);
      seenIds.add(id);
      records.push({
        id,
        code,
        name,
        location: String(source.location || '').trim(),
        address: String(source.address || '').trim(),
        phone: String(source.phone || '').trim(),
        status: String(source.status || 'فعالة').trim(),
        services,
        facilityType: String(source.facilityType || '').trim(),
        coordinates: String(source.coordinates || '').trim(),
        coLocatedHospital: String(source.coLocatedHospital || '').trim(),
        coLocated: Boolean(source.coLocated),
        notes: String(source.notes || '').trim(),
        sourceMetadata: source.sourceMetadata && typeof source.sourceMetadata === 'object' && !Array.isArray(source.sourceMetadata) ? source.sourceMetadata : {},
      });
    }
    const client = await pool.connect();
    let created = 0;
    let updated = 0;
    let importStage = 'starting';
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['phc-clinic-json-import-v1']);
      importStage = 'service_catalog';
      for (const [serviceCode, serviceName] of canonicalServices) {
        const namedService = await client.query('UPDATE service_catalog SET active=true WHERE name=$1 RETURNING id', [serviceName]);
        if (namedService.rowCount) continue;
        const codedService = await client.query('SELECT id FROM service_catalog WHERE code=$1', [serviceCode]);
        if (codedService.rowCount) {
          await client.query('UPDATE service_catalog SET name=$2,active=true WHERE code=$1', [serviceCode, serviceName]);
        } else {
          await client.query('INSERT INTO service_catalog(code,name,active) VALUES($1,$2,true)', [serviceCode, serviceName]);
        }
      }
      importStage = 'existing_clinics';
      const existing = await client.query("SELECT record_id,payload FROM app_records WHERE resource='clinics' FOR UPDATE");
      const byCode = new Map(existing.rows.map((row) => [String(row.payload.code || ''), row]));
      const byId = new Map(existing.rows.map((row) => [row.record_id, row]));
      for (const record of records) {
        importStage = `clinic:${record.code}`;
        const prior = byCode.get(record.code) || byId.get(record.id);
        const recordId = prior?.record_id || record.id;
        const payload = { ...record, id: recordId };
        await client.query(
          `INSERT INTO app_records(resource,record_id,clinic_ref,payload,updated_by)
           VALUES('clinics',$1,$1,$2::jsonb,$3)
           ON CONFLICT(resource,record_id) DO UPDATE SET clinic_ref=EXCLUDED.clinic_ref,payload=EXCLUDED.payload,
             version=app_records.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [recordId, JSON.stringify(payload), user.id],
        );
        await syncNormalized(client, 'clinics', payload, recordId);
        if (prior) updated += 1; else created += 1;
      }
      importStage = 'audit';
      await client.query(
        `INSERT INTO audit_events(actor_user_id,action,entity_type,request_id,details)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [user.id, 'clinics.json.imported', 'clinic', requestId, JSON.stringify({ clinicRef: null, created, updated, total: records.length })],
      );
      importStage = 'commit';
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Clinic JSON import failed', { requestId, stage: importStage, code: error.code || '', constraint: error.constraint || '', message: error.message });
      return send(res, 500, { error: 'clinic_import_failed', requestId });
    } finally { client.release(); }
    const state = await loadState(user);
    return send(res, 200, { ok: true, created, updated, total: records.length, clinics: state.prcsDemoClinicsV1, requestId });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/integrations/clients') {
    if (!user || user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required', requestId });
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const scopes = [...new Set(Array.isArray(body.scopes) ? body.scopes.map((scope) => String(scope).trim()).filter((scope) => /^[a-z][a-z0-9:._-]{1,63}$/.test(scope)) : [])];
    if (!name || name.length > 160 || !scopes.length || scopes.length > 20) return send(res, 400, { error: 'invalid_integration_client', requestId });
    const clientId = `prcs_${opaqueToken(18)}`;
    const clientSecret = opaqueToken(36);
    const created = await pool.query('INSERT INTO integration_clients(client_id,secret_hash,name,scopes) VALUES($1,$2,$3,$4) RETURNING id,client_id,name,scopes,enabled,created_at', [clientId, await hashPassword(clientSecret), name, scopes]);
    await audit({ actorId: user.id, action: 'integration.client.created', entityType: 'integration_client', entityId: created.rows[0].id, sourceSystem: clientId, requestId, details: { scopes } });
    return send(res, 201, { client: created.rows[0], clientSecret, requestId }, { 'Cache-Control': 'no-store' });
  }
  if (url.pathname === '/api/v1/integrations/clients' && req.method === 'GET') {
    if (!user || user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required', requestId });
    const { rows } = await pool.query('SELECT id,client_id,name,scopes,enabled,created_at,last_used_at FROM integration_clients ORDER BY created_at DESC LIMIT 500');
    return send(res, 200, { clients: rows, requestId });
  }
  const revokeClient = /^\/api\/v1\/integrations\/clients\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokeClient && req.method === 'POST') {
    if (!user || user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required', requestId });
    const result = await pool.query('UPDATE integration_clients SET enabled=false WHERE client_id=$1 RETURNING id,client_id,enabled', [decodeURIComponent(revokeClient[1])]);
    if (!result.rowCount) return send(res, 404, { error: 'integration_client_not_found', requestId });
    await pool.query('DELETE FROM integration_access_tokens WHERE client_id=$1', [result.rows[0].id]);
    await audit({ actorId: user.id, action: 'integration.client.revoked', entityType: 'integration_client', entityId: result.rows[0].id, sourceSystem: result.rows[0].client_id, requestId });
    return send(res, 200, { client: result.rows[0], requestId });
  }
  if (!user && !['/api/v1/interop/identity-map', '/api/v1/patients/lookup'].includes(url.pathname)) {
    return send(res, 403, { error: 'human_session_required', requestId });
  }
  const patientIdentityMatch = req.method === 'GET' ? /^\/api\/v1\/patients\/([^/]+)\/identity$/.exec(url.pathname) : null;
  if (patientIdentityMatch) {
    if (!['system_admin','clinic_admin','clinician','reception','pharmacist','lab_technician'].includes(user.role)) {
      return send(res, 403, { error: 'patient_identity_forbidden', requestId });
    }
    const fileNo = decodeURIComponent(patientIdentityMatch[1]);
    const result = await pool.query(
      `SELECT p.national_id_ciphertext,r.clinic_ref,r.payload
         FROM app_records r
         LEFT JOIN patients p ON p.patient_number=COALESCE(NULLIF(r.payload->>'fileNo',''),r.record_id)
        WHERE r.resource='patients' AND r.record_id=$1`,
      [fileNo],
    );
    if (!result.rows[0]) {
      result = await pool.query(
        `SELECT NULL::uuid AS id,p.record_id AS patient_number,
                p.payload->>'name' AS full_name,NULL::text AS national_id_ciphertext,
                NULLIF(p.payload->>'dateOfBirth','')::date AS date_of_birth,
                p.payload->>'gender' AS gender,p.payload->>'phone' AS phone,
                p.payload->>'alternatePhone' AS alternate_phone,p.payload->>'address' AS address,
                p.clinic_ref,p.payload,NULL::text AS visit_number,NULL::text AS source_visit_id,
                NULL::timestamptz AS occurred_at,NULL::text AS status,NULL::text AS service,
                p.payload->>'clinic' AS clinic
           FROM app_records dose
           JOIN app_records p ON p.resource='patients' AND p.record_id=dose.payload->>'fileNo'
          WHERE dose.resource='immunizations'
            AND regexp_replace(COALESCE(dose.payload->>'sourcePersonId',''),'[^0-9]','','g')=$1
          ORDER BY dose.created_at DESC
          LIMIT 1`,
        [nationalId],
      );
    }
    if (!result.rows[0]) return send(res, 404, { error: 'patient_not_found', requestId });
    if (user.role !== 'system_admin') {
      const row = result.rows[0];
      const clinics = (await pool.query("SELECT payload FROM app_records WHERE resource='clinics'")).rows.map((item) => item.payload);
      const hasClinicAccess = user.clinicRefs.includes(String(row.clinic_ref || '')) ||
        user.clinicRefs.includes(normalizedClinicRef(row.payload, clinics)) ||
        (row.payload.visits || []).some((visit) => user.clinicRefs.includes(normalizedClinicRef(visit, clinics)));
      if (!hasClinicAccess) return send(res, 403, { error: 'patient_outside_user_clinic', requestId });
    }
    const nationalId = decryptNationalId(result.rows[0].national_id_ciphertext);
    await audit({ actorId: user.id, clinicRef: result.rows[0].clinic_ref, action: 'patient.identity.viewed', entityType: 'patient', entityId: fileNo, requestId });
    return send(res, 200, { nationalId, requestId });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/audit/view') {
    const body = await readJson(req);
    if (body.entityType !== 'patient' || !String(body.entityId || '').trim()) return send(res, 400, { error: 'invalid_audit_event' });
    const record = await pool.query("SELECT clinic_ref,payload FROM app_records WHERE resource='patients' AND record_id=$1", [String(body.entityId)]);
    if (!record.rowCount) return send(res, 404, { error: 'patient_not_found' });
    if (user.role !== 'system_admin') {
      const clinics = (await pool.query("SELECT payload FROM app_records WHERE resource='clinics'")).rows.map((row) => row.payload);
      const ownVisit = (record.rows[0].payload.visits || []).some((visit) => user.clinicRefs.includes(normalizedClinicRef(visit, clinics)));
      if (!ownVisit && !user.clinicRefs.includes(String(record.rows[0].clinic_ref || ''))) return send(res, 403, { error: 'patient_outside_user_clinic' });
    }
    await audit({ actorId: user.id, action: 'patient.view', entityType: 'patient', entityId: String(body.entityId), requestId });
    return send(res, 200, { ok: true, requestId });
  }
  if (req.method === 'PUT' && url.pathname.startsWith('/api/v1/records/')) {
    const resource = decodeURIComponent(url.pathname.split('/').at(-1));
    const result = await replaceResource(user, resource, await readJson(req), req);
    return send(res, result.status, result.payload);
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/interop/identity-map') {
    if (user ? !['system_admin', 'clinic_admin'].includes(user.role) : !hasScope(integration, 'identity-map:read')) return send(res, 403, { error: 'forbidden' });
    const { rows } = await pool.query(
      `SELECT m.entity_type,m.local_id,m.external_id,m.external_version,m.last_synced_at,s.code AS source_system
         FROM integration_identity_map m JOIN integration_systems s ON s.id=m.system_id
        ORDER BY s.code,m.entity_type,m.local_id LIMIT 1000`,
    );
    return send(res, 200, { data: rows, requestId });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/interop/identity-map') {
    if (user ? user.role !== 'system_admin' : !hasScope(integration, 'identity-map:write')) return send(res, 403, { error: 'identity_map_write_forbidden' });
    const body = await readJson(req);
    const sourceCode = String(body.sourceSystem || '').trim().toLowerCase();
    const sourceName = String(body.sourceName || sourceCode).trim();
    const entityType = String(body.entityType || '').trim().toLowerCase();
    const localId = String(body.localId || '').trim();
    const externalId = String(body.externalId || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(sourceCode) || !/^[a-z][a-z0-9._-]{1,63}$/.test(entityType) || !localId || !externalId || localId.length > 250 || externalId.length > 250) {
      return send(res, 400, { error: 'invalid_identity_map' });
    }
    try {
      const source = await pool.query('INSERT INTO integration_systems(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id', [sourceCode, sourceName]);
      const mapped = await pool.query(
        `INSERT INTO integration_identity_map(system_id,entity_type,local_id,external_id,external_version,last_synced_at,metadata)
         VALUES($1,$2,$3,$4,$5,now(),$6::jsonb)
         ON CONFLICT(system_id,entity_type,local_id) DO UPDATE SET external_id=EXCLUDED.external_id,external_version=EXCLUDED.external_version,last_synced_at=now(),metadata=EXCLUDED.metadata
         RETURNING id,entity_type,local_id,external_id,external_version,last_synced_at`,
        [source.rows[0].id, entityType, localId, externalId, String(body.externalVersion || '') || null, JSON.stringify(body.metadata || {})],
      );
      await audit({ actorId: user?.id || null, action: 'interop.identity_map.upsert', entityType, entityId: localId, sourceSystem: sourceCode, requestId, details: { integrationClient: integration?.clientId || null } });
      return send(res, 200, { mapping: mapped.rows[0], sourceSystem: sourceCode, requestId });
    } catch (error) {
      if (error.code === '23505') return send(res, 409, { error: 'external_id_already_mapped' });
      throw error;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/users') {
    if (user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required' });
    const { rows } = await pool.query(
      `SELECT u.id,u.username,u.display_name AS "displayName",u.role,u.active,u.created_at,
              COALESCE(array_agg(c.clinic_ref) FILTER (WHERE c.clinic_ref IS NOT NULL),'{}') AS "clinicRefs"
         FROM app_users u LEFT JOIN user_clinic_refs c ON c.user_id=u.id
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`,
    );
    return send(res, 200, { users: rows, requestId });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/users') {
    if (user.role !== 'system_admin') return send(res, 403, { error: 'system_admin_required' });
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || '');
    const displayName = String(body.displayName || '').trim();
    const clinicRefs = Array.isArray(body.clinicRefs) ? [...new Set(body.clinicRefs.map(String))] : [];
    if (!/^[a-z0-9._-]{3,64}$/.test(username) || password.length < 12 || !displayName || !['clinic_admin','clinician','reception','pharmacist','lab_technician','viewer'].includes(role)) {
      return send(res, 400, { error: 'invalid_user_data', requirements: { username: '3-64 lowercase letters, digits, dot, underscore or hyphen', password: '12+ characters' } });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query('INSERT INTO app_users(username,password_hash,display_name,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role', [username, await hashPassword(password), displayName, role]);
      const validClinics = new Set((await client.query("SELECT record_id FROM app_records WHERE resource='clinics'")).rows.map((r) => r.record_id));
      for (const clinicRef of clinicRefs) {
        if (!validClinics.has(clinicRef)) throw Object.assign(new Error('unknown_clinic'), { status: 400 });
        await client.query('INSERT INTO user_clinic_refs(user_id,clinic_ref) VALUES($1,$2)', [created.rows[0].id, clinicRef]);
      }
      await audit({ actorId: user.id, action: 'user.created', entityType: 'user', entityId: created.rows[0].id, requestId, details: { role } });
      await client.query('COMMIT');
      return send(res, 201, { user: created.rows[0], clinicRefs });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return send(res, 409, { error: 'username_already_exists' });
      throw error;
    } finally { client.release(); }
  }
  if (['GET','POST'].includes(req.method) && url.pathname === '/api/v1/patients/lookup') {
    if (!user && !hasScope(integration, 'patients:lookup')) return send(res, 403, { error: 'patient_lookup_forbidden', requestId });
    if (user && !['system_admin','clinic_admin','clinician','reception','pharmacist','lab_technician'].includes(user.role)) {
      return send(res, 403, { error: 'patient_lookup_forbidden', requestId });
    }
    const lookupBody = req.method === 'POST' ? await readJson(req) : {};
    const nationalId = String(req.method === 'POST' ? (lookupBody.nationalId || '') : (url.searchParams.get('nationalId') || '')).replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776)).replace(/[^0-9]/g, '');
    if (nationalId.length < 6 || nationalId.length > 20) return send(res, 400, { error: 'invalid_national_id', requestId });
    const digest = hashNationalId(nationalId);
    let result = await pool.query(
      `SELECT p.id,p.patient_number,p.full_name,p.national_id_ciphertext,p.date_of_birth,p.gender,p.phone,p.alternate_phone,p.address,
              r.clinic_ref,r.payload,v.visit_number,v.clinical_data->>'id' AS source_visit_id,v.occurred_at,v.status,
              s.name AS service,c.name AS clinic
         FROM patients p
         LEFT JOIN app_records r ON r.resource='patients' AND r.record_id=p.patient_number
         LEFT JOIN LATERAL (SELECT * FROM visits WHERE patient_id=p.id ORDER BY occurred_at DESC LIMIT 1) v ON true
         LEFT JOIN clinics c ON c.id=v.clinic_id
         LEFT JOIN service_catalog s ON s.id=v.service_id
        WHERE p.national_id_hash=$1 LIMIT 1`,
      [digest],
    );
    if (!result.rows[0]) {
      result = await pool.query(
        `SELECT NULL::uuid AS id,r.record_id AS patient_number,
                r.payload->>'name' AS full_name,NULL::text AS national_id_ciphertext,
                NULLIF(r.payload->>'dateOfBirth','')::date AS date_of_birth,
                r.payload->>'gender' AS gender,r.payload->>'phone' AS phone,
                r.payload->>'alternatePhone' AS alternate_phone,r.payload->>'address' AS address,
                r.clinic_ref,r.payload,NULL::text AS visit_number,NULL::text AS source_visit_id,
                NULL::timestamptz AS occurred_at,NULL::text AS status,NULL::text AS service,
                r.payload->>'clinic' AS clinic
           FROM app_records r
          WHERE r.resource='patients'
            AND regexp_replace(COALESCE(r.payload->'archiveSource'->>'personId',''),'[^0-9]','','g')=$1
          LIMIT 1`,
        [nationalId],
      );
    }
    if (!result.rows[0]) return send(res, 404, { error: 'patient_not_found', requestId });
    const row = result.rows[0];
    if (user && user.role !== 'system_admin') {
      const clinics = (await pool.query("SELECT payload FROM app_records WHERE resource='clinics'")).rows.map((item) => item.payload);
      const hasClinicAccess = user.clinicRefs.includes(String(row.clinic_ref || '')) ||
        user.clinicRefs.includes(normalizedClinicRef(row.payload, clinics)) ||
        (row.payload?.visits || []).some((visit) => user.clinicRefs.includes(normalizedClinicRef(visit, clinics)));
      if (!hasClinicAccess) return send(res, 403, { error: 'patient_outside_user_clinic', requestId });
    }
    const payload = row.payload || {};
    const archivedVisit = (payload.visits || []).slice().sort((a,b)=>new Date(b.date||0)-new Date(a.date||0))[0];
    const latestVisit = row.visit_number ? {
      id: row.source_visit_id || row.visit_number, date: row.occurred_at,
      clinic: row.clinic || payload.clinic || '', service: row.service || '',
      status: row.status || '', type: 'آخر زيارة',
    } : archivedVisit ? {
      id: archivedVisit.id || archivedVisit.date, date: archivedVisit.date,
      clinic: archivedVisit.clinic || '', service: archivedVisit.service || '',
      status: archivedVisit.status || '', type: archivedVisit.type || 'زيارة',
    } : null;
    await audit({
      actorId: user?.id || null, action: 'patient.lookup', entityType: 'patient',
      entityId: row.patient_number, sourceSystem: integration?.clientId || null,
      requestId, details: { purpose: user ? 'reception_search' : 'authorized_integration' },
    });
    return send(res, 200, { patient: {
      id: row.id || row.patient_number, fileNo: row.patient_number,
      name: row.full_name || payload.name || 'مريض',
      nationalId: decryptNationalId(row.national_id_ciphertext) || nationalId,
      dateOfBirth: row.date_of_birth || payload.dateOfBirth || '',
      gender: row.gender || payload.gender || '', phone: row.phone || payload.phone || '',
      alternatePhone: row.alternate_phone || payload.alternatePhone || '',
      address: row.address || payload.address || '', clinic: row.clinic || payload.clinic || '',
      clinicId: row.clinic_ref || payload.clinicId || '',
      visits: latestVisit ? [latestVisit] : [],
    }, requestId });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/pharmacy/dispense') {
    if (!['system_admin','clinic_admin','pharmacist'].includes(user.role)) return send(res, 403, { error: 'pharmacist_role_required' });
    const body = await readJson(req);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) return send(res, 400, { error: 'invalid_dispense_items' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const clinic = await client.query("SELECT record_id,payload FROM app_records WHERE resource='clinics' AND (record_id=$1 OR payload->>'name'=$1 OR payload->>'code'=$1) LIMIT 1", [String(body.clinic || '')]);
      if (!clinic.rows[0]) throw Object.assign(new Error('clinic_not_found'), { status: 404 });
      const clinicRef = clinic.rows[0].record_id;
      if (user.role !== 'system_admin' && !user.clinicRefs.includes(clinicRef)) throw Object.assign(new Error('clinic_scope_forbidden'), { status: 403 });
      if (user.role === 'clinic_admin' && !user.clinicRefs.includes(clinicRef)) throw Object.assign(new Error('clinic_scope_forbidden'), { status: 403 });
      const patientResult = await client.query("SELECT record_id,clinic_ref,payload FROM app_records WHERE resource='patients' AND record_id=$1 FOR UPDATE", [String(body.fileNo || '')]);
      if (!patientResult.rows[0]) throw Object.assign(new Error('patient_not_found'), { status: 404 });
      const patient = patientResult.rows[0].payload;
      if (user.role !== 'system_admin') {
        const clinics = (await client.query("SELECT payload FROM app_records WHERE resource='clinics'")).rows.map((row) => row.payload);
        const hasClinicHistory = (patient.visits || []).some((visit) => normalizedClinicRef(visit, clinics) === clinicRef);
        if (!hasClinicHistory && patientResult.rows[0].clinic_ref !== clinicRef) throw Object.assign(new Error('patient_outside_user_clinic'), { status: 403 });
      }
      const stockChanges = [];
      const newDispenses = [];
      const now = new Date().toISOString();
      const visitId = `visit-${randomUUID()}`;
      const medications = [];
      for (const item of body.items) {
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || !String(item.dose || '').trim()) throw Object.assign(new Error('invalid_quantity_or_dose'), { status: 400 });
        const stockResult = await client.query("SELECT record_id,clinic_ref,payload FROM app_records WHERE resource='pharmacy_stock' AND record_id=$1 FOR UPDATE", [String(item.stockId || '')]);
        const stockRow = stockResult.rows[0];
        if (!stockRow || stockRow.clinic_ref !== clinicRef) throw Object.assign(new Error('stock_not_available_in_clinic'), { status: 409 });
        const stock = stockRow.payload;
        if (quantity > Number(stock.quantity || 0)) throw Object.assign(new Error('insufficient_stock'), { status: 409 });
        const drug = (await client.query("SELECT payload FROM app_records WHERE resource='drug_catalog' AND record_id=$1", [String(stock.drugId)])).rows[0]?.payload;
        if (!drug) throw Object.assign(new Error('drug_not_found'), { status: 404 });
        const updated = { ...stock, quantity: Number(stock.quantity) - quantity };
        await client.query('UPDATE app_records SET payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now() WHERE resource=$1 AND record_id=$2', ['pharmacy_stock', stockRow.record_id, JSON.stringify(updated), user.id]);
        stockChanges.push(updated);
        const med = { name: `${drug.name} · ${stock.strength || ''}`.trim(), dose: String(item.dose), duration: String(item.duration || 'حسب الوصفة'), quantity: `${quantity} ${stock.unit || ''}`.trim() };
        medications.push(med);
        newDispenses.push({ id: `disp-${randomUUID()}`, date: now, patientName: patient.name, fileNo: patient.fileNo, drugName: drug.name, strength: stock.strength || '', quantity, unit: stock.unit || '', clinic: clinic.rows[0].payload.name, clinicId: clinicRef, visitId, stockId: stockRow.record_id, dose: String(item.dose), duration: String(item.duration || ''), instructions: String(body.instructions || '') });
        const normalizedStock = await client.query('SELECT id FROM pharmacy_stock WHERE source_record_id=$1 FOR UPDATE', [stockRow.record_id]);
        if (normalizedStock.rows[0]) await client.query('UPDATE pharmacy_stock SET quantity=$2,updated_at=now() WHERE id=$1', [normalizedStock.rows[0].id, updated.quantity]);
      }
      const visit = {
        id: visitId, date: now, clinic: clinic.rows[0].payload.name, clinicId: clinicRef, service: 'صيدلية وصرف أدوية',
        type: 'صرف أدوية', status: 'مكتملة', provider: user.displayName, complaint: 'صرف أدوية من مخزون الصيدلية.',
        assessment: 'تم التحقق من المريض والأرصدة قبل الصرف.', plan: String(body.instructions || '').trim() || 'الالتزام بالجرعات والمدد المحددة لكل دواء.',
        vitals: {}, medications, procedures: ['صرف أدوية من الصيدلية'], referral: 'لا توجد إحالة مسجلة.',
      };
      const allClinics = (await client.query("SELECT payload FROM app_records WHERE resource='clinics'")).rows.map((row) => row.payload);
      const retainedVisits = user.role === 'system_admin' ? (patient.visits || []) : (patient.visits || []).filter((prior) => user.clinicRefs.includes(normalizedClinicRef(prior, allClinics)));
      const updatedPatient = { ...patient, clinic: visit.clinic, clinicId: clinicRef, visits: [...retainedVisits, visit] };
      await client.query('UPDATE app_records SET clinic_ref=$3,payload=$4::jsonb,version=version+1,updated_by=$5,updated_at=now() WHERE resource=$1 AND record_id=$2', ['patients', patientResult.rows[0].record_id, clinicRef, JSON.stringify(updatedPatient), user.id]);
      await client.query("INSERT INTO app_records(resource,record_id,clinic_ref,patient_id,payload,created_by,updated_by) VALUES('visits',$1,$2,NULL,$3::jsonb,$4,$4) ON CONFLICT(resource,record_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()", [visitId, clinicRef, JSON.stringify({ ...visit, fileNo: patient.fileNo }), user.id]);
      for (const dispense of newDispenses) {
        await client.query("INSERT INTO app_records(resource,record_id,clinic_ref,payload,created_by,updated_by) VALUES('dispenses',$1,$2,$3::jsonb,$4,$4) ON CONFLICT(resource,record_id) DO NOTHING", [dispense.id, clinicRef, JSON.stringify(dispense), user.id]);
      }
      await syncNormalized(client, 'patients', updatedPatient, patient.fileNo);
      const typedVisit = await client.query('SELECT id FROM visits WHERE visit_number=$1', [`${patient.fileNo}:${visitId}`]);
      if (typedVisit.rows[0]) await client.query('UPDATE visits SET created_by=$2 WHERE id=$1', [typedVisit.rows[0].id, user.id]);
      for (const dispense of newDispenses) await syncNormalized(client, 'dispenses', dispense, dispense.id);
      await audit({ actorId: user.id, clinicRef, action: 'pharmacy.dispense', entityType: 'visit', entityId: visitId, requestId, details: { fileNo: patient.fileNo, itemCount: newDispenses.length } });
      await client.query('COMMIT');
      return send(res, 201, { visit, patient: updatedPatient, stocks: stockChanges, dispenses: newDispenses, requestId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return send(res, 404, { error: 'not_found', requestId });
}

function contentType(path) {
  const extension = extname(path).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[extension] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'method_not_allowed' });
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const safe = normalize(requested).replace(/^([.][.][/\\])+/, '');
  const path = join(root, safe);
  if (!path.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  try {
    const info = await stat(path);
    if (!info.isFile()) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': contentType(path), 'Content-Length': info.size,
      'Cache-Control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  } catch { return send(res, 404, { error: 'not_found' }); }
}

async function main() {
  requiredEnv('DATABASE_URL');
  requiredEnv('SESSION_SECRET', 32);
  requiredEnv('DATA_ENCRYPTION_KEY', 64);
  requiredEnv('DATA_LOOKUP_KEY', 64);
  await pool.query('SELECT 1');
  try {
    if (await seedDemoData(pool, syncNormalized)) console.log('Loaded clearly labeled demo records');
  } catch (error) {
    console.error('Demo records could not be loaded; application startup will continue:', error.message);
  }
  try {
    if (await seedClinicMappingData(pool, syncNormalized)) console.log('Imported mapped PRCS clinics and services');
  } catch (error) {
    console.error('Clinic mapping import could not be loaded; application startup will continue:', error.message);
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (error) {
      console.error('request failed', { message: error.message, code: error.code });
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'internal_error' });
      else res.destroy();
    }
  });
  const port = Number(process.env.PORT || 8080);
  server.listen(port, '0.0.0.0', () => console.log(`PHC application listening on ${port}`));
  const close = async () => { server.close(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

main().catch((error) => { console.error('Startup failed:', error.message); process.exit(1); });

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  location text,
  address text,
  phone text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('system_admin','clinic_admin','clinician','reception','pharmacist','lab_technician','viewer')),
  active boolean NOT NULL DEFAULT true,
  staff_external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_clinics (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, clinic_id)
);
CREATE TABLE IF NOT EXISTS user_clinic_refs (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  clinic_ref text NOT NULL,
  PRIMARY KEY (user_id, clinic_ref)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS service_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clinic_services (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_catalog(id),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (clinic_id, service_id)
);

CREATE TABLE IF NOT EXISTS staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  external_code text,
  display_name text NOT NULL,
  job_title text NOT NULL,
  specialty_service_id uuid REFERENCES service_catalog(id),
  phone text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, external_code)
);
CREATE TABLE IF NOT EXISTS staff_services (
  staff_id uuid NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_catalog(id),
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  donor text,
  starts_on date,
  ends_on date,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE TABLE IF NOT EXISTS project_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES service_catalog(id),
  goal text NOT NULL,
  UNIQUE (project_id, service_id)
);
CREATE TABLE IF NOT EXISTS project_indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  project_service_id uuid NOT NULL REFERENCES project_services(id) ON DELETE CASCADE,
  code text,
  name text NOT NULL,
  unit text NOT NULL,
  baseline numeric NOT NULL DEFAULT 0,
  target numeric NOT NULL DEFAULT 0,
  frequency text,
  UNIQUE (project_service_id, name)
);
CREATE TABLE IF NOT EXISTS clinic_project_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  project_service_id uuid NOT NULL REFERENCES project_services(id),
  indicator_id uuid REFERENCES project_indicators(id),
  clinic_goal text,
  target numeric NOT NULL DEFAULT 0,
  coverage_percent numeric NOT NULL DEFAULT 100 CHECK (coverage_percent BETWEEN 0 AND 100),
  starts_on date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (clinic_id, project_service_id)
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_number text NOT NULL UNIQUE,
  national_id_hash text UNIQUE,
  national_id_ciphertext text,
  full_name text NOT NULL,
  date_of_birth date,
  gender text,
  phone text,
  alternate_phone text,
  address text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patients_name_idx ON patients USING gin (to_tsvector('simple', full_name));
CREATE TABLE IF NOT EXISTS visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_number text UNIQUE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  service_id uuid REFERENCES service_catalog(id),
  provider_id uuid REFERENCES staff_members(id),
  project_allocation_id uuid REFERENCES clinic_project_services(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'completed',
  chief_complaint text,
  assessment text,
  diagnosis text,
  plan text,
  vitals jsonb NOT NULL DEFAULT '{}'::jsonb,
  clinical_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_patient_date_idx ON visits(patient_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS visits_clinic_date_idx ON visits(clinic_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  visit_id uuid NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  referral_type text NOT NULL,
  destination text NOT NULL,
  target_service_id uuid REFERENCES service_catalog(id),
  urgency text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  follow_up_at timestamptz,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drug_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  code text UNIQUE,
  generic_name text NOT NULL,
  brand_name text,
  strength text,
  dosage_form text,
  unit text,
  aliases text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS pharmacy_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  drug_id uuid NOT NULL REFERENCES drug_catalog(id),
  batch_number text,
  expiry_date date,
  quantity numeric NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_cost numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, drug_id, batch_number)
);
CREATE TABLE IF NOT EXISTS dispensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  visit_id uuid NOT NULL REFERENCES visits(id),
  stock_id uuid NOT NULL REFERENCES pharmacy_stock(id),
  quantity numeric NOT NULL CHECK (quantity > 0),
  dose text,
  duration text,
  instructions text,
  dispensed_by uuid REFERENCES app_users(id),
  dispensed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lab_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  visit_id uuid NOT NULL REFERENCES visits(id),
  test_code text,
  test_name text NOT NULL,
  specimen text,
  priority text NOT NULL DEFAULT 'routine',
  status text NOT NULL DEFAULT 'requested',
  result_value text,
  result_unit text,
  reference_range text,
  result_notes text,
  requested_by uuid REFERENCES app_users(id),
  performed_by uuid REFERENCES app_users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resulted_at timestamptz
);
CREATE TABLE IF NOT EXISTS immunizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text UNIQUE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  visit_id uuid REFERENCES visits(id),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  vaccine_code text,
  vaccine_name text NOT NULL,
  dose text NOT NULL,
  status text NOT NULL,
  administered_at timestamptz,
  due_at timestamptz,
  batch_number text,
  administered_by uuid REFERENCES app_users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Transitional document store for the existing screen model. Each document retains a stable ID
-- and explicit clinic/patient links while the UI is migrated to the normalized tables above.
CREATE TABLE IF NOT EXISTS app_records (
  resource text NOT NULL,
  record_id text NOT NULL,
  clinic_ref text,
  patient_id uuid REFERENCES patients(id),
  payload jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_by uuid REFERENCES app_users(id),
  updated_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource, record_id)
);
CREATE INDEX IF NOT EXISTS app_records_clinic_resource_idx ON app_records(clinic_ref, resource);
CREATE INDEX IF NOT EXISTS app_records_patient_idx ON app_records(patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_records_payload_idx ON app_records USING gin(payload jsonb_path_ops);

CREATE TABLE IF NOT EXISTS integration_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integration_identity_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id uuid NOT NULL REFERENCES integration_systems(id),
  entity_type text NOT NULL,
  local_id text NOT NULL,
  external_id text NOT NULL,
  external_version text,
  last_synced_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (system_id, entity_type, external_id),
  UNIQUE (system_id, entity_type, local_id)
);
CREATE INDEX IF NOT EXISTS integration_map_local_idx ON integration_identity_map(entity_type, local_id);
CREATE TABLE IF NOT EXISTS integration_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS integration_access_tokens (
  token_hash text PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES integration_clients(id) ON DELETE CASCADE,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_tokens_expiry_idx ON integration_access_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES app_users(id),
  clinic_id uuid REFERENCES clinics(id),
  action text NOT NULL,
  entity_type text,
  entity_id text,
  source_system text,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO service_catalog(code, name) VALUES
 ('general-medicine','طب عام'), ('nursing','تمريض'), ('nutrition','تغذية'),
 ('vaccination','تطعيم'), ('maternal-care','رعاية أمومة'), ('child-care','رعاية طفل'),
 ('mental-health','صحة نفسية'), ('dental','صحة فم وأسنان'), ('laboratory','مختبر'),
 ('radiology','أشعة'), ('pharmacy','صيدلية'), ('health-education','تثقيف صحي')
ON CONFLICT (code) DO NOTHING;

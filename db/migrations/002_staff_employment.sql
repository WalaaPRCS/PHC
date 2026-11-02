ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS employment_type text,
  ADD COLUMN IF NOT EXISTS employment_status text NOT NULL DEFAULT 'على رأس العمل';

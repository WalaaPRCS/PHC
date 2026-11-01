#!/bin/sh
set -eu

secret_dir=/run/phc-secrets
export SESSION_SECRET="$(cat "$secret_dir/session_secret")"
export DATA_ENCRYPTION_KEY="$(cat "$secret_dir/data_encryption_key")"
export DATA_LOOKUP_KEY="$(cat "$secret_dir/data_lookup_key")"
database_password="$(cat "$secret_dir/postgres_password")"
export DATABASE_URL="postgres://${DB_USER}:${database_password}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

exec npm start

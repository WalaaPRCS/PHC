#!/bin/sh
set -eu

/bin/sh /run/init-secrets.sh

secret_dir=/run/phc-secrets
password=$(cat "$secret_dir/postgres_password")
if [ "${#password}" -ne 64 ]; then
  echo "PostgreSQL password secret is missing or invalid" >&2
  exit 1
fi
export POSTGRES_PASSWORD="$password"
unset password

echo "Runtime secrets are ready; starting PostgreSQL."
exec /usr/local/bin/docker-entrypoint.sh postgres

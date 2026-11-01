#!/bin/sh
set -eu

secret_dir=${PHC_SECRET_DIR:-/run/phc-secrets}
umask 077
mkdir -p "$secret_dir"

for name in postgres_password session_secret data_encryption_key data_lookup_key; do
  file="$secret_dir/$name"
  if [ ! -s "$file" ]; then
    temporary="$file.tmp.$$"
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$temporary"
    if [ "$(wc -c < "$temporary" | tr -d ' ')" -ne 64 ]; then
      rm -f "$temporary"
      echo "Failed to generate $name" >&2
      exit 1
    fi
    mv "$temporary" "$file"
  fi
done

chmod 0755 "$secret_dir"
chmod 0444 "$secret_dir"/*

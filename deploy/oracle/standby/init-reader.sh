#!/bin/sh
set -eu

reader_password_file="/run/secrets/reader-password"
if [ ! -s "$reader_password_file" ]; then
  echo "Secret password reader standby tidak tersedia." >&2
  exit 1
fi

reader_password="$(cat "$reader_password_file")"
psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set reader_password="$reader_password" <<'SQL'
select format(
  'create role eposyandu_reader login password %L',
  :'reader_password'
)
where not exists (select 1 from pg_roles where rolname = 'eposyandu_reader')
\gexec

alter role eposyandu_reader set default_transaction_read_only = on;
revoke create on schema public from public;
revoke all on database eposyandu_standby from public;
grant connect on database eposyandu_standby to eposyandu_reader;
grant usage on schema public to eposyandu_reader;
SQL

unset reader_password

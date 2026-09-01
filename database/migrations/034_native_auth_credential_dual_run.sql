begin;

-- Tahap berikutnya migrasi autentikasi: lacak perpindahan credential secara
-- bertahap. Supabase tetap menjadi verifier selama dual-run; tabel ini hanya
-- menyimpan status migrasi dan tidak menyimpan password atau token.
create table if not exists public.auth_credential_migration_state (
  user_id uuid primary key references public.app_users(user_id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'migrated')),
  supabase_verified_at timestamptz,
  native_hashed_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_credential_migration_state_status
  on public.auth_credential_migration_state (status, updated_at desc);

-- Semua akun lama tetap pending sampai berhasil melewati verifikasi password
-- Supabase dan hash Argon2id berhasil ditulis ke auth_credentials.
insert into public.auth_credential_migration_state (user_id)
select user_id from public.app_users
on conflict (user_id) do nothing;

create index if not exists idx_auth_credentials_last_password_login
  on public.auth_credentials (last_password_login_at desc)
  where last_password_login_at is not null;

insert into public.schema_migrations (version, description)
values ('034', 'native credential migration dual-run state')
on conflict (version) do nothing;

commit;

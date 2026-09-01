begin;

-- Tahap berikutnya migrasi autentikasi administrator: catat metadata faktor
-- MFA/passkey dari provider lama tanpa menyalin secret TOTP atau material
-- kunci publik. Supabase tetap menjadi verifier selama dual-run.
create table if not exists public.auth_security_migration_state (
  user_id uuid primary key references public.app_users(user_id) on delete cascade,
  mfa_status text not null default 'pending'
    check (mfa_status in ('pending', 'shadowed', 'migrated')),
  passkey_status text not null default 'pending'
    check (passkey_status in ('pending', 'shadowed', 'migrated')),
  supabase_totp_count integer not null default 0 check (supabase_totp_count >= 0),
  supabase_passkey_count integer not null default 0 check (supabase_passkey_count >= 0),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_security_migration_status
  on public.auth_security_migration_state (mfa_status, passkey_status, updated_at desc);

-- Hanya administrator yang perlu dicatat pada tahap ini. Profil dan scope
-- akun tidak disentuh; baris ini hanya menyiapkan status migrasi keamanan.
insert into public.auth_security_migration_state (user_id)
select user_id
from public.app_users
where role = 'super_admin'
on conflict (user_id) do nothing;

insert into public.schema_migrations (version, description)
values ('035', 'native administrator MFA and passkey metadata dual-run state')
on conflict (version) do nothing;

commit;

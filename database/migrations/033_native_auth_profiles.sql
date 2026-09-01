begin;

-- Tahap kedua migrasi autentikasi Oracle: salin profil akun ke PostgreSQL
-- native, tetapi pertahankan Supabase sebagai sumber identitas/login selama
-- masa validasi. Tidak ada perubahan pada nilai di public.app_users.

create table if not exists public.auth_profiles (
  user_id uuid primary key references public.app_users(user_id) on delete cascade,
  username text,
  email text,
  role text not null,
  village text,
  posyandu text,
  active boolean not null default true,
  access_mode text not null default 'write',
  source_updated_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_profiles_username_unique
  on public.auth_profiles (lower(username))
  where username is not null;

create unique index if not exists idx_auth_profiles_email_unique
  on public.auth_profiles (lower(email))
  where email is not null;

create index if not exists idx_auth_profiles_active
  on public.auth_profiles (active, updated_at desc);

-- Backfill idempoten dari profil yang sudah dipakai aplikasi. Kolom scope
-- disalin apa adanya; tidak ada UPDATE/DELETE ke public.app_users.
insert into public.auth_profiles (
  user_id,
  username,
  email,
  role,
  village,
  posyandu,
  active,
  access_mode,
  source_updated_at,
  created_at,
  updated_at
)
select
  users.user_id,
  users.username,
  users.email,
  users.role,
  users.village,
  users.posyandu,
  users.active,
  users.access_mode,
  users.updated_at,
  users.created_at,
  users.updated_at
from public.app_users users
on conflict (user_id) do update
set
  username = excluded.username,
  email = excluded.email,
  role = excluded.role,
  village = excluded.village,
  posyandu = excluded.posyandu,
  active = excluded.active,
  access_mode = excluded.access_mode,
  source_updated_at = excluded.source_updated_at,
  updated_at = excluded.updated_at;

-- Selama Supabase dan Oracle berjalan berdampingan, setiap perubahan profil
-- pada app_users otomatis disalin ke tabel native. display name/avatar belum
-- dipisahkan karena belum tersedia pada sumber profil lama.
create or replace function public.eposyandu_sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.auth_profiles where user_id = old.user_id;
    return old;
  end if;

  insert into public.auth_profiles (
    user_id,
    username,
    email,
    role,
    village,
    posyandu,
    active,
    access_mode,
    source_updated_at,
    created_at,
    updated_at
  )
  values (
    new.user_id,
    new.username,
    new.email,
    new.role,
    new.village,
    new.posyandu,
    new.active,
    new.access_mode,
    new.updated_at,
    new.created_at,
    new.updated_at
  )
  on conflict (user_id) do update
  set
    username = excluded.username,
    email = excluded.email,
    role = excluded.role,
    village = excluded.village,
    posyandu = excluded.posyandu,
    active = excluded.active,
    access_mode = excluded.access_mode,
    source_updated_at = excluded.source_updated_at,
    updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists app_users_sync_auth_profile on public.app_users;
create trigger app_users_sync_auth_profile
after insert or update of username, email, role, village, posyandu, active,
  access_mode, created_at, updated_at or delete on public.app_users
for each row execute function public.eposyandu_sync_auth_profile();

revoke all on function public.eposyandu_sync_auth_profile() from public;

insert into public.schema_migrations (version, description)
values ('033', 'native account profiles with Supabase coexistence sync')
on conflict (version) do nothing;

commit;

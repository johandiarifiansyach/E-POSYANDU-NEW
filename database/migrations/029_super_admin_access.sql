begin;

-- Tambahkan role administrator aplikasi tanpa mengubah role atau scope akun
-- yang sudah ada. Role ini bukan PostgreSQL superuser dan tetap tunduk pada
-- autentikasi aplikasi serta MFA di Oracle API.
alter table public.app_users
  drop constraint if exists app_users_role_check;
alter table public.app_users
  add constraint app_users_role_check check (
    role in ('Kader Posyandu', 'Bidan Desa', 'Ahli Gizi', 'super_admin')
  ) not valid;
alter table public.app_users validate constraint app_users_role_check;

alter table public.app_users
  drop constraint if exists app_users_check;
alter table public.app_users
  drop constraint if exists app_users_scope_check;
alter table public.app_users
  add constraint app_users_scope_check check (
    (role = 'Kader Posyandu' and village is not null and posyandu is not null)
    or (role = 'Bidan Desa' and village is not null and posyandu is null)
    or (role in ('Ahli Gizi', 'super_admin') and village is null and posyandu is null)
  ) not valid;
alter table public.app_users validate constraint app_users_scope_check;

-- Pertahankan helper kompatibilitas agar super_admin mendapat cakupan penuh
-- jika jalur service-role lama dipakai saat pemulihan, tanpa membuka kembali
-- RPC langsung kepada browser.
create or replace function public.eposyandu_scope_match(
  p_role text,
  p_scope_village text,
  p_scope_posyandu text,
  p_village text,
  p_posyandu text
)
returns boolean
language sql
immutable
as $$
  select case
    when p_role in ('Ahli Gizi', 'super_admin') then true
    when p_role = 'Bidan Desa' then p_village = p_scope_village
    when p_role = 'Kader Posyandu' then
      p_village = p_scope_village and p_posyandu = p_scope_posyandu
    else false
  end
$$;

create or replace function public.eposyandu_location_allowed(
  p_village text,
  p_posyandu text
)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.app_users users
    where users.user_id = auth.uid()
      and users.active
      and (
        users.role in ('Ahli Gizi', 'super_admin')
        or (users.role = 'Bidan Desa' and users.village = p_village)
        or (
          users.role = 'Kader Posyandu'
          and users.village = p_village
          and users.posyandu = p_posyandu
        )
      )
  )
$$;

revoke all on function public.eposyandu_scope_match(text, text, text, text, text)
  from public;
revoke all on function public.eposyandu_location_allowed(text, text)
  from public;

-- Supabase memiliki role API berikut; PostgreSQL Oracle tidak. Terapkan hak
-- kompatibilitas hanya jika role terkait tersedia pada target migrasi.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.eposyandu_scope_match(text, text, text, text, text) from anon';
    execute 'revoke all on function public.eposyandu_location_allowed(text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.eposyandu_scope_match(text, text, text, text, text) from authenticated';
    execute 'revoke all on function public.eposyandu_location_allowed(text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_scope_match(text, text, text, text, text) to service_role';
    execute 'grant execute on function public.eposyandu_location_allowed(text, text) to service_role';
  end if;
end
$$;

insert into public.schema_migrations (version, description)
values ('029', 'super admin application role with full scoped access')
on conflict (version) do nothing;

commit;

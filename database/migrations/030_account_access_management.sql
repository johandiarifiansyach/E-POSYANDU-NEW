begin;

-- Akun lama tetap memiliki perilaku yang sama. Kolom baru memakai nilai
-- bawaan write dan tidak melakukan UPDATE terhadap satu pun akun yang ada.
alter table public.app_users
  add column if not exists access_mode text not null default 'write';

alter table public.app_users
  drop constraint if exists app_users_access_mode_check;
alter table public.app_users
  add constraint app_users_access_mode_check check (
    access_mode in ('read', 'write')
    and (role <> 'super_admin' or access_mode = 'write')
  ) not valid;
alter table public.app_users validate constraint app_users_access_mode_check;

-- Jalur tulis kompatibilitas yang masih memakai helper ini juga wajib
-- menghormati akun hanya-baca. Scope untuk operasi baca tetap ditentukan oleh
-- eposyandu_scope_match dan tidak dipersempit oleh perubahan ini.
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
      and users.access_mode = 'write'
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

revoke all on function public.eposyandu_location_allowed(text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.eposyandu_location_allowed(text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.eposyandu_location_allowed(text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_location_allowed(text, text) to service_role';
  end if;
end
$$;

-- Sertakan perubahan mode akses pada audit database yang sudah tersedia.
create or replace function public.eposyandu_audit_app_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_events (
    request_id,
    actor_user_id,
    actor_role,
    action,
    resource,
    document_id,
    village,
    posyandu,
    before_data,
    after_data,
    metadata
  )
  values (
    format('db-role-%s-%s', txid_current(), new.user_id),
    coalesce(auth.uid()::text, current_user),
    'database',
    'role_change',
    'app_users',
    new.user_id::text,
    new.village,
    new.posyandu,
    jsonb_build_object(
      'role', old.role,
      'village', old.village,
      'posyandu', old.posyandu,
      'accessMode', old.access_mode,
      'active', old.active
    ),
    jsonb_build_object(
      'role', new.role,
      'village', new.village,
      'posyandu', new.posyandu,
      'accessMode', new.access_mode,
      'active', new.active
    ),
    jsonb_build_object('source', 'database_trigger')
  );

  return new;
end;
$$;

drop trigger if exists app_users_audit_role_change on public.app_users;
create trigger app_users_audit_role_change
after update of role, village, posyandu, access_mode, active on public.app_users
for each row
when (
  old.role is distinct from new.role
  or old.village is distinct from new.village
  or old.posyandu is distinct from new.posyandu
  or old.access_mode is distinct from new.access_mode
  or old.active is distinct from new.active
)
execute function public.eposyandu_audit_app_user_role_change();

insert into public.schema_migrations (version, description)
values ('030', 'administrator account lifecycle and read-only access mode')
on conflict (version) do nothing;

commit;

begin;

-- The authenticated measurement fallback depends on this helper. Recreate it
-- independently so restored or partially migrated databases keep role-scoped
-- writes available without weakening village and posyandu boundaries.
create or replace function public.eposyandu_location_allowed(
  p_village text,
  p_posyandu text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.app_users users
    where users.user_id = auth.uid()
      and users.active
      and (
        users.role = 'Ahli Gizi'
        or (users.role = 'Bidan Desa' and users.village = p_village)
        or (
          users.role = 'Kader Posyandu'
          and users.village = p_village
          and users.posyandu = p_posyandu
        )
      )
  );
$$;

revoke all on function public.eposyandu_location_allowed(text, text) from public, anon;
grant execute on function public.eposyandu_location_allowed(text, text) to authenticated, service_role;

insert into public.schema_migrations (version, description)
values ('019', 'restore role-scoped location helper required by measurement sync')
on conflict (version) do nothing;

commit;

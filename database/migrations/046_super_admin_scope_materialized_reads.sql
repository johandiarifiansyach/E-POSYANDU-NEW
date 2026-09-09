begin;

-- The seven-argument scope helper is used by the materialized Python result
-- functions.  It predates the super_admin role and therefore required a
-- village scope for administrators, yielding empty pages for a super_admin
-- even when measurement_analysis was populated.  Keep the legacy five-
-- argument overload untouched and make the materialized read path honor the
-- same full-scope rule as the native API.
create or replace function public.eposyandu_scope_match(
  p_village text,
  p_posyandu text,
  p_requested_village text,
  p_requested_posyandu text,
  p_role text,
  p_scope_village text,
  p_scope_posyandu text
) returns boolean
language sql
immutable
as $$
  select (p_requested_village is null or p_village = p_requested_village)
    and (p_requested_posyandu is null or p_posyandu = p_requested_posyandu)
    and (p_role in ('Ahli Gizi', 'super_admin') or p_village = p_scope_village)
    and (p_role <> 'Kader Posyandu' or p_posyandu = p_scope_posyandu)
$$;

insert into public.schema_migrations(version, description)
values ('046', 'allow super_admin full scope on materialized read helper')
on conflict (version) do nothing;

commit;

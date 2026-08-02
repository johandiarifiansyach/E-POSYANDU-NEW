begin;

-- The browser must use the Rust Worker. These grants keep the Supabase REST
-- endpoint closed even if a public project key is discovered in an old build.
revoke all on table
  public.app_users,
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.pmt_programs,
  public.pmt_monitorings,
  public.change_logs,
  public.change_log_entries,
  public.sync_tombstones
from anon, authenticated;

grant all on table
  public.app_users,
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.pmt_programs,
  public.pmt_monitorings,
  public.change_logs,
  public.change_log_entries,
  public.sync_tombstones
to service_role;

grant usage, select on all sequences in schema public to service_role;

alter table public.app_users force row level security;
alter table public.children force row level security;
alter table public.measurements force row level security;
alter table public.mpasi_logs force row level security;
alter table public.pmt_programs force row level security;
alter table public.pmt_monitorings force row level security;
alter table public.change_logs force row level security;
alter table public.change_log_entries force row level security;
alter table public.sync_tombstones force row level security;

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

create or replace function public.eposyandu_child_allowed(
  p_child_id text,
  p_fallback_village text default null,
  p_fallback_posyandu text default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_location_allowed(
    coalesce((select child.village from public.children child where child.id = p_child_id), p_fallback_village),
    coalesce((select child.posyandu from public.children child where child.id = p_child_id), p_fallback_posyandu)
  );
$$;

create or replace function public.eposyandu_program_allowed(p_program_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_child_allowed(program.child_id)
  from public.pmt_programs program
  where program.id = p_program_id;
$$;

create or replace function public.eposyandu_change_log_allowed(p_change_log_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_child_allowed(log.child_id)
  from public.change_logs log
  where log.id = p_change_log_id;
$$;

revoke all on function public.eposyandu_location_allowed(text, text) from public;
revoke all on function public.eposyandu_child_allowed(text, text, text) from public;
revoke all on function public.eposyandu_program_allowed(text) from public;
revoke all on function public.eposyandu_change_log_allowed(text) from public;
grant execute on function public.eposyandu_location_allowed(text, text) to authenticated, service_role;
grant execute on function public.eposyandu_child_allowed(text, text, text) to authenticated, service_role;
grant execute on function public.eposyandu_program_allowed(text) to authenticated, service_role;
grant execute on function public.eposyandu_change_log_allowed(text) to authenticated, service_role;

drop policy if exists app_users_read_self on public.app_users;
create policy app_users_read_self on public.app_users
  for select to authenticated
  using (active and user_id = auth.uid());

drop policy if exists children_by_location on public.children;
create policy children_by_location on public.children
  for all to authenticated
  using (public.eposyandu_location_allowed(village, posyandu))
  with check (public.eposyandu_location_allowed(village, posyandu));

drop policy if exists measurements_by_child on public.measurements;
create policy measurements_by_child on public.measurements
  for all to authenticated
  using (public.eposyandu_child_allowed(child_id, legacy_village, legacy_posyandu))
  with check (public.eposyandu_child_allowed(child_id, legacy_village, legacy_posyandu));

drop policy if exists mpasi_logs_by_child on public.mpasi_logs;
create policy mpasi_logs_by_child on public.mpasi_logs
  for all to authenticated
  using (public.eposyandu_child_allowed(child_id))
  with check (public.eposyandu_child_allowed(child_id));

drop policy if exists pmt_programs_by_child on public.pmt_programs;
create policy pmt_programs_by_child on public.pmt_programs
  for all to authenticated
  using (public.eposyandu_child_allowed(child_id))
  with check (public.eposyandu_child_allowed(child_id));

drop policy if exists pmt_monitorings_by_program on public.pmt_monitorings;
create policy pmt_monitorings_by_program on public.pmt_monitorings
  for all to authenticated
  using (public.eposyandu_program_allowed(program_id))
  with check (public.eposyandu_program_allowed(program_id));

drop policy if exists change_logs_by_child on public.change_logs;
create policy change_logs_by_child on public.change_logs
  for all to authenticated
  using (public.eposyandu_child_allowed(child_id))
  with check (public.eposyandu_child_allowed(child_id));

drop policy if exists change_log_entries_by_log on public.change_log_entries;
create policy change_log_entries_by_log on public.change_log_entries
  for all to authenticated
  using (public.eposyandu_change_log_allowed(change_log_id))
  with check (public.eposyandu_change_log_allowed(change_log_id));

drop policy if exists sync_tombstones_by_location on public.sync_tombstones;
create policy sync_tombstones_by_location on public.sync_tombstones
  for all to authenticated
  using (public.eposyandu_location_allowed(village, posyandu))
  with check (public.eposyandu_location_allowed(village, posyandu));

commit;

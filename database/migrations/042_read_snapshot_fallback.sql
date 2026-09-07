begin;

-- A fresh snapshot is preferred by Rust, but a temporary Python outage or a
-- scope-version bump must not turn a read into an empty page.  This function
-- returns the most recent persisted result for the exact dashboard request,
-- even when its source scope version is older than the current version.  The
-- caller marks the response as stale and can refresh it asynchronously.
create or replace function public.eposyandu_dashboard_snapshot_latest(
  p_cache_key text,
  p_scope_key text,
  p_month_start date,
  p_month_end date,
  p_previous_month_start date,
  p_previous_month_end date,
  p_age_group text,
  p_village text default null,
  p_posyandu text default null
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'hit', true,
      'stale', true,
      'result', d.result_json,
      'sourceVersion', d.source_scope_version,
      'currentVersion', coalesce(s.version, d.source_scope_version),
      'calculatedAt', d.calculated_at,
      'analytics', 'python-dashboard-materialized-v1'
    )
    from public.dashboard_analysis d
    left join public.analysis_scope_versions s on s.scope_key = d.scope_key
    where d.cache_key = p_cache_key
      and d.scope_key = coalesce(nullif(trim(p_scope_key), ''), 'global')
      and d.month_start = p_month_start
      and d.month_end = p_month_end
      and d.previous_month_start = p_previous_month_start
      and d.previous_month_end = p_previous_month_end
    order by d.calculated_at desc
    limit 1
  ), jsonb_build_object('hit', false));
$$;

revoke all on function public.eposyandu_dashboard_snapshot_latest(
  text, text, date, date, date, date, text, text, text
) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'eposyandu_api') then
    execute 'grant execute on function public.eposyandu_dashboard_snapshot_latest(text,text,date,date,date,date,text,text,text) to eposyandu_api';
  end if;
end
$$;

insert into public.schema_migrations(version, description)
values ('042', 'Rust read fallback to latest persisted dashboard snapshot')
on conflict (version) do nothing;

commit;

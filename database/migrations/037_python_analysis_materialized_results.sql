begin;

-- Python is the only authority for clinical/longitudinal values.  Raw writes
-- still commit immediately in PostgreSQL; these tables hold the asynchronous
-- Python projection used by fast Rust/Redis reads.
create sequence if not exists public.analysis_result_version_seq;

create table if not exists public.measurement_analysis (
  measurement_id text primary key references public.measurements(id) on delete cascade,
  child_id text not null,
  bbu_status text,
  tbu_status text,
  bbtb_status text,
  imtu_status text,
  lila_status text,
  lk_status text,
  bbu_z_score numeric,
  tbu_z_score numeric,
  bbtb_z_score numeric,
  imtu_z_score numeric,
  lila_z_score numeric,
  lk_z_score numeric,
  weight_gain_status char(1) check (weight_gain_status in ('N', 'T', 'B', 'O')),
  weight_gain_minimum_grams integer,
  exclusive_breastfeeding_status text,
  result_json jsonb not null default '{}'::jsonb,
  source_fingerprint text not null,
  source_updated_at timestamptz not null,
  analysis_version bigint not null default nextval('public.analysis_result_version_seq'),
  calculated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_measurement_analysis_child on public.measurement_analysis(child_id);
create index if not exists idx_measurement_analysis_statuses
  on public.measurement_analysis(bbu_status, tbu_status, bbtb_status, weight_gain_status);
create index if not exists idx_measurement_analysis_version
  on public.measurement_analysis(analysis_version desc);

create table if not exists public.analysis_scope_versions (
  scope_key text primary key,
  version bigint not null default 1,
  updated_at timestamptz not null default timezone('utc', now())
);
insert into public.analysis_scope_versions(scope_key) values ('global') on conflict do nothing;

create table if not exists public.dashboard_analysis (
  cache_key text primary key,
  scope_key text not null,
  month_start date not null,
  month_end date not null,
  previous_month_start date not null,
  previous_month_end date not null,
  village text,
  posyandu text,
  result_json jsonb not null,
  source_scope_version bigint not null,
  calculated_at timestamptz not null default timezone('utc', now())
);
create index if not exists idx_dashboard_analysis_scope on public.dashboard_analysis(scope_key, source_scope_version);

create or replace function public.eposyandu_bump_analysis_scope(p_scope_key text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_version bigint;
begin
  insert into public.analysis_scope_versions(scope_key, version, updated_at)
  values (coalesce(nullif(trim(p_scope_key), ''), 'global'), 2, timezone('utc', now()))
  on conflict (scope_key) do update set version = public.analysis_scope_versions.version + 1,
    updated_at = timezone('utc', now())
  returning version into v_version;
  return v_version;
end;
$$;

create table if not exists public.analysis_outbox (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id text not null,
  child_id text,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default timezone('utc', now()),
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists idx_analysis_outbox_claim
  on public.analysis_outbox(status, available_at, id);
create index if not exists idx_analysis_outbox_child on public.analysis_outbox(child_id, created_at desc);

-- Coalesce bursts for the same child while retaining a durable audit trail.
create or replace function public.eposyandu_enqueue_analysis_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_id text;
  v_child_id text;
  v_scope_key text;
  v_old_scope_key text;
begin
  v_entity_id := coalesce(to_jsonb(new)->>'id', to_jsonb(old)->>'id');
  if tg_table_name = 'pmt_monitorings' then
    v_entity_id := coalesce(to_jsonb(new)->>'program_id', to_jsonb(old)->>'program_id', '')
      || ':' || coalesce(to_jsonb(new)->>'week_number', to_jsonb(old)->>'week_number', '');
  elsif tg_table_name = 'sync_tombstones' then
    v_entity_id := coalesce(to_jsonb(new)->>'resource', to_jsonb(old)->>'resource', '')
      || ':' || coalesce(to_jsonb(new)->>'document_id', to_jsonb(old)->>'document_id', '');
  end if;
  v_child_id := case tg_table_name
    when 'children' then v_entity_id
    when 'measurements' then coalesce(
      to_jsonb(new)->>'child_id', to_jsonb(old)->>'child_id',
      to_jsonb(new)->>'legacy_child_id', to_jsonb(old)->>'legacy_child_id'
    )
    when 'mpasi_logs' then coalesce(
      to_jsonb(new)->>'child_id', to_jsonb(old)->>'child_id',
      to_jsonb(new)->>'legacy_child_id', to_jsonb(old)->>'legacy_child_id'
    )
    when 'pmt_programs' then coalesce(
      to_jsonb(new)->>'child_id', to_jsonb(old)->>'child_id',
      to_jsonb(new)->>'legacy_child_id', to_jsonb(old)->>'legacy_child_id'
    )
    when 'pmt_monitorings' then (
      select coalesce(p.child_id, nullif(p.legacy_child_id, '')) from public.pmt_programs p
      where p.id = coalesce(to_jsonb(new)->>'program_id', to_jsonb(old)->>'program_id')
    )
    when 'change_logs' then coalesce(
      to_jsonb(new)->>'child_id', to_jsonb(old)->>'child_id',
      to_jsonb(new)->>'legacy_child_id', to_jsonb(old)->>'legacy_child_id'
    )
    when 'change_log_entries' then (
      select coalesce(l.child_id, nullif(l.legacy_child_id, '')) from public.change_logs l
      where l.id = coalesce(to_jsonb(new)->>'change_log_id', to_jsonb(old)->>'change_log_id')
    )
    else null
  end;
  if v_entity_id is null or v_entity_id = '' then
    v_entity_id := tg_table_name;
  end if;
  if v_child_id is not null and v_child_id <> '' then
    select trim(coalesce(c.village, '')) || '/' || trim(coalesce(c.posyandu, ''))
      into v_scope_key from public.children c where c.id = v_child_id;
  end if;
  -- A child can move between villages/Posyandu. Invalidate both the new and
  -- old scope, plus the wildcard scopes used by village-only and
  -- Posyandu-only dashboard filters.
  if tg_table_name = 'children' and tg_op <> 'INSERT' then
    v_old_scope_key := trim(coalesce(to_jsonb(old)->>'village', '')) || '/' ||
      trim(coalesce(to_jsonb(old)->>'posyandu', ''));
  end if;
  perform public.eposyandu_bump_analysis_scope('global');
  if coalesce(v_scope_key, '') <> '' and v_scope_key <> '/' then
    perform public.eposyandu_bump_analysis_scope(v_scope_key);
    perform public.eposyandu_bump_analysis_scope(split_part(v_scope_key, '/', 1) || '/-');
    perform public.eposyandu_bump_analysis_scope('-/' || split_part(v_scope_key, '/', 2));
  end if;
  if coalesce(v_old_scope_key, '') <> '' and v_old_scope_key <> '/' and v_old_scope_key <> v_scope_key then
    perform public.eposyandu_bump_analysis_scope(v_old_scope_key);
    perform public.eposyandu_bump_analysis_scope(split_part(v_old_scope_key, '/', 1) || '/-');
    perform public.eposyandu_bump_analysis_scope('-/' || split_part(v_old_scope_key, '/', 2));
  end if;
  insert into public.analysis_outbox(entity_type, entity_id, child_id, operation)
  select tg_table_name, v_entity_id, nullif(v_child_id, ''), lower(tg_op)
  where not exists (
    select 1 from public.analysis_outbox q
    where q.entity_type = tg_table_name
      and q.entity_id = v_entity_id
      and q.status in ('pending', 'processing')
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Every source table that can affect a table/status/education result feeds the
-- same Python queue.  The worker is idempotent, so replaying a job is safe.
drop trigger if exists children_enqueue_analysis on public.children;
create trigger children_enqueue_analysis after insert or update or delete on public.children
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists measurements_enqueue_analysis on public.measurements;
create trigger measurements_enqueue_analysis after insert or update or delete on public.measurements
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists mpasi_logs_enqueue_analysis on public.mpasi_logs;
create trigger mpasi_logs_enqueue_analysis after insert or update or delete on public.mpasi_logs
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists pmt_programs_enqueue_analysis on public.pmt_programs;
create trigger pmt_programs_enqueue_analysis after insert or update or delete on public.pmt_programs
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists pmt_monitorings_enqueue_analysis on public.pmt_monitorings;
create trigger pmt_monitorings_enqueue_analysis after insert or update or delete on public.pmt_monitorings
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists change_logs_enqueue_analysis on public.change_logs;
create trigger change_logs_enqueue_analysis after insert or update or delete on public.change_logs
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists change_log_entries_enqueue_analysis on public.change_log_entries;
create trigger change_log_entries_enqueue_analysis after insert or update or delete on public.change_log_entries
for each row execute function public.eposyandu_enqueue_analysis_job();
drop trigger if exists sync_tombstones_enqueue_analysis on public.sync_tombstones;
create trigger sync_tombstones_enqueue_analysis after insert or update or delete on public.sync_tombstones
for each row execute function public.eposyandu_enqueue_analysis_job();

-- Backfill is also asynchronous; migration never blocks on WHO calculations.
-- One child job is sufficient because the Python materializer rebuilds the
-- complete chronological projection for that child.  Queuing every
-- measurement as well would repeat the same work once per historical row.
insert into public.analysis_outbox(entity_type, entity_id, child_id, operation)
select 'children', c.id, c.id, 'insert'
from public.children c
where not exists (
  select 1 from public.analysis_outbox q
  where q.entity_type = 'children' and q.entity_id = c.id
);

-- Add Python-derived values to the existing page projection without changing
-- the raw API contract.  If a row is still pending, Rust returns the raw row
-- and a processing marker; no stale clinical value is invented.
create or replace function public.eposyandu_materialized_children_page(
  p_as_of date, p_measurement_start date, p_measurement_end date,
  p_page integer, p_size integer, p_sort text, p_view text default 'data',
  p_search text default null, p_village text default null, p_posyandu text default null,
  p_role text default 'Ahli Gizi', p_scope_village text default null, p_scope_posyandu text default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if p_view not in ('data', 'recent', 'recycle', 'mpasi',
                    'problem_underweight', 'problem_stunting',
                    'problem_wasting', 'problem_tidak_naik') then
    raise exception 'Tampilan data balita tidak valid.';
  end if;
  if p_sort not in ('recent', 'oldest_input', 'name_asc', 'name_desc', 'age_oldest', 'age_youngest') then
    raise exception 'Urutan data balita tidak valid.';
  end if;

  -- Problem tabs are already classified by Python in measurement_analysis.
  -- Filter and paginate the materialized result here so a read never has to
  -- send the entire population back through the analysis service.
  if p_view like 'problem_%' then
    with scoped as (
      select c.*
      from public.children c
      where c.deleted_at is null
        and c.birth_date <= p_as_of
        and c.birth_date > (p_as_of - interval '60 months')::date
        and public.eposyandu_scope_match(
          c.village, c.posyandu, nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
          p_role, p_scope_village, p_scope_posyandu
        )
        and (
          nullif(trim(coalesce(p_search, '')), '') is null
          or c.name ilike '%' || trim(p_search) || '%'
          or c.national_id ilike '%' || trim(p_search) || '%'
        )
    ), latest as (
      select distinct on (c.id)
        c.id as child_id, c.name, c.national_id, c.has_national_id,
        c.birth_date, c.sex, c.parent_name, c.village, c.posyandu,
        c.created_at, c.updated_at, c.version, c.deleted_at, c.delete_reason,
        m.id as measurement_id, m.legacy_child_name, m.legacy_village,
        m.legacy_posyandu, m.measurement_date, m.weight_kg, m.height_cm,
        m.head_circumference_cm, m.mid_upper_arm_circumference_cm, m.edema,
        m.mother_class_attendance, m.mbg, m.vitamin_a,
        m.exclusive_breastfeeding, m.measurement_method, m.age_in_months,
        m.created_at as measurement_created_at, m.updated_at as measurement_updated_at,
        m.version as measurement_version,
        a.bbu_status, a.tbu_status, a.bbtb_status, a.imtu_status,
        a.lila_status, a.lk_status, a.bbu_z_score, a.tbu_z_score,
        a.bbtb_z_score, a.imtu_z_score, a.lila_z_score, a.lk_z_score,
        a.weight_gain_status, a.weight_gain_minimum_grams,
        a.exclusive_breastfeeding_status, a.result_json
      from scoped c
      join public.measurements m
        on coalesce(m.child_id, nullif(m.legacy_child_id, '')) = c.id
      join public.measurement_analysis a on a.measurement_id = m.id
      where m.measurement_date between p_measurement_start and p_measurement_end
      order by c.id, m.measurement_date desc, m.created_at desc, m.id desc
    ), filtered as (
      select *
      from latest l
      where (p_view = 'problem_underweight' and l.bbu_status in ('Berat Sangat Kurang', 'Berat Kurang'))
         or (p_view = 'problem_stunting' and l.tbu_status in ('Sangat Pendek', 'Pendek'))
         or (p_view = 'problem_wasting' and l.bbtb_status in ('Gizi Buruk', 'Gizi Kurang'))
         or (p_view = 'problem_tidak_naik' and l.weight_gain_status = 'T')
    ), ordered as (
      select f.*,
        row_number() over (
          order by
            case when p_sort = 'name_asc' then lower(f.name) end asc nulls last,
            case when p_sort = 'name_desc' then lower(f.name) end desc nulls last,
            case when p_sort = 'oldest_input' then f.created_at end asc nulls last,
            case when p_sort = 'recent' then f.created_at end desc nulls last,
            case when p_sort = 'age_oldest' then f.birth_date end asc nulls last,
            case when p_sort = 'age_youngest' then f.birth_date end desc nulls last,
            lower(f.name), f.child_id
        ) as page_order
      from filtered f
    ), paged as (
      select * from ordered
      where page_order > greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50))
        and page_order <= greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50))
          + greatest(1, least(coalesce(p_size, 10), 50))
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', child_id,
        'data', jsonb_build_object(
          'nama', name, 'nik', national_id, 'hasNIK', has_national_id,
          'tglLahir', birth_date, 'jk', sex, 'namaOrtu', parent_name,
          'desa', village, 'posyandu', posyandu,
          'createdAt', created_at, 'updatedAt', updated_at, 'version', version,
          'deletedAt', deleted_at, 'deleteReason', delete_reason
        )
      ) order by page_order) from paged), '[]'::jsonb),
      'measurements', coalesce((select jsonb_agg(jsonb_build_object(
        'id', measurement_id,
        'data', jsonb_build_object(
          'childId', child_id, 'childName', legacy_child_name,
          'desa', legacy_village, 'posyandu', legacy_posyandu,
          'tglUkur', measurement_date, 'bb', weight_kg, 'tb', height_cm,
          'lk', head_circumference_cm, 'lila', mid_upper_arm_circumference_cm,
          'edema', edema, 'kelasIbu', mother_class_attendance, 'mbg', mbg,
          'vitA', vitamin_a, 'asi', exclusive_breastfeeding,
          'caraUkur', measurement_method, 'ageInMonths', age_in_months,
          'createdAt', measurement_created_at, 'updatedAt', measurement_updated_at,
          'version', measurement_version, 'statusNaik', weight_gain_status,
          'weightGainStatus', weight_gain_status,
          'weightGainMinimumGrams', weight_gain_minimum_grams,
          'bbuStatus', bbu_status, 'tbuStatus', tbu_status,
          'bbtbStatus', bbtb_status, 'imtuStatus', imtu_status,
          'lilaStatus', lila_status, 'lkStatus', lk_status,
          'bbuZScore', bbu_z_score, 'tbuZScore', tbu_z_score,
          'bbtbZScore', bbtb_z_score, 'imtuZScore', imtu_z_score,
          'lilaZScore', lila_z_score, 'lkZScore', lk_z_score,
          'exclusiveBreastfeedingStatus', exclusive_breastfeeding_status,
          'analysis', result_json, 'analysisPending', false
        )
      ) order by page_order) from paged), '[]'::jsonb),
      'mpasiLogs', '[]'::jsonb,
      'total', (select count(*) from filtered),
      'pageLimited', false,
      'calculator', 'python-deterministic-lms',
      'analytics', 'postgresql-read-python-write-v1',
      'standardsVersion', 'WHO-2006-2007-LMS'
    ) into v_result;
    return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'measurements', '[]'::jsonb, 'mpasiLogs', '[]'::jsonb, 'total', 0));
  end if;

  v_result := public.eposyandu_replica_children_page(
    p_as_of, p_measurement_start, p_measurement_end, p_page, p_size, p_sort,
    p_view, p_search, p_village, p_posyandu, p_role, p_scope_village, p_scope_posyandu
  );
  return jsonb_build_object(
    'items', coalesce(v_result->'items', '[]'::jsonb),
    'measurements', coalesce((
      select jsonb_agg(
        jsonb_set(
          elem.value,
          '{data}',
          coalesce(elem.value->'data', '{}'::jsonb) || case when a.measurement_id is null then
            jsonb_build_object(
              'bbuStatus', null, 'tbuStatus', null, 'bbtbStatus', null,
              'imtuStatus', null, 'lilaStatus', null, 'lkStatus', null,
              'bbuZScore', null, 'tbuZScore', null, 'bbtbZScore', null,
              'imtuZScore', null, 'lilaZScore', null, 'lkZScore', null,
              'statusNaik', null, 'weightGainStatus', null,
              'weightGainMinimumGrams', null,
              'exclusiveBreastfeedingStatus', null, 'analysis', null,
              'analysisPending', true
            )
          else jsonb_build_object(
            'bbuStatus', a.bbu_status, 'tbuStatus', a.tbu_status,
            'bbtbStatus', a.bbtb_status, 'imtuStatus', a.imtu_status,
            'lilaStatus', a.lila_status, 'lkStatus', a.lk_status,
            'bbuZScore', a.bbu_z_score, 'tbuZScore', a.tbu_z_score,
            'bbtbZScore', a.bbtb_z_score, 'imtuZScore', a.imtu_z_score,
            'lilaZScore', a.lila_z_score, 'lkZScore', a.lk_z_score,
            'statusNaik', a.weight_gain_status,
            'weightGainStatus', a.weight_gain_status,
            'weightGainMinimumGrams', a.weight_gain_minimum_grams,
            'exclusiveBreastfeedingStatus', a.exclusive_breastfeeding_status,
            'analysis', a.result_json, 'analysisPending', false
          ) end
      ) order by elem.ordinality
      )
      from jsonb_array_elements(coalesce(v_result->'measurements', '[]'::jsonb)) with ordinality elem(value, ordinality)
      left join public.measurement_analysis a on a.measurement_id = elem.value->>'id'
    ), '[]'::jsonb),
    'mpasiLogs', coalesce(v_result->'mpasiLogs', '[]'::jsonb),
    'total', coalesce(v_result->'total', 0),
    'pageLimited', true,
    'calculator', 'python-deterministic-lms',
    'analytics', 'postgresql-read-python-write-v1',
    'standardsVersion', 'WHO-2006-2007-LMS',
    'analysisVersion', (select coalesce(max(analysis_version), 0) from public.measurement_analysis)
  );
end;
$$;

create or replace function public.eposyandu_materialized_exclusive_breastfeeding_page(
  p_measurement_start date, p_measurement_end date, p_age_group text,
  p_page integer, p_size integer, p_village text default null, p_posyandu text default null,
  p_role text default 'Ahli Gizi', p_scope_village text default null, p_scope_posyandu text default null
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  -- ASI membership is decided by Python's complete 0-6-month context.  The
  -- materialized function only serves completed rows written by that worker.
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(x.item order by x.name), '[]'::jsonb),
    'total', count(*)::integer,
    'calculator', 'python-materialized-asi-context-v1',
    'analytics', 'postgresql-read-python-write-v1'
  ) into v_result
  from (
    select c.name, jsonb_build_object(
      'id', c.id,
      'data', jsonb_build_object(
        'nama', c.name, 'nik', c.national_id, 'hasNIK', c.has_national_id,
        'tglLahir', c.birth_date, 'desa', c.village, 'posyandu', c.posyandu,
        'tglUkur', m.measurement_date, 'ageInMonths', m.age_in_months,
        'asiStatus', 'Ya'
      )
    ) item
    from public.children c
    join public.measurements m on coalesce(m.child_id, nullif(m.legacy_child_id, '')) = c.id
    join public.measurement_analysis a on a.measurement_id = m.id
      and a.exclusive_breastfeeding_status = 'Ya'
    where c.deleted_at is null
      and m.measurement_date between p_measurement_start and p_measurement_end
      and ((p_age_group = '0-5' and m.age_in_months between 0 and 5) or (p_age_group = '6' and m.age_in_months = 6))
      and public.eposyandu_scope_match(c.village, c.posyandu, p_village, p_posyandu, p_role, p_scope_village, p_scope_posyandu)
    order by m.measurement_date desc, m.created_at desc, m.id desc
  ) x;
  return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'total', 0));
end;
$$;

create or replace function public.eposyandu_dashboard_snapshot(
  p_cache_key text, p_scope_key text, p_month_start date, p_month_end date,
  p_previous_month_start date, p_previous_month_end date,
  p_village text default null, p_posyandu text default null
) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'hit', true, 'result', d.result_json,
      'sourceVersion', d.source_scope_version,
      'analytics', 'python-dashboard-materialized-v1'
    )
    from public.dashboard_analysis d
    join public.analysis_scope_versions s on s.scope_key = d.scope_key
    where d.cache_key = p_cache_key
      and d.scope_key = coalesce(nullif(trim(p_scope_key), ''), 'global')
      and d.month_start = p_month_start and d.month_end = p_month_end
      and d.previous_month_start = p_previous_month_start and d.previous_month_end = p_previous_month_end
      and d.source_scope_version = s.version
    order by d.calculated_at desc limit 1
  ), jsonb_build_object('hit', false));
$$;

revoke all on table public.measurement_analysis, public.analysis_scope_versions, public.analysis_outbox, public.dashboard_analysis from public;
-- Oracle uses the dedicated API role rather than Supabase's service_role.
grant select, insert, update, delete on public.measurement_analysis, public.analysis_scope_versions, public.analysis_outbox, public.dashboard_analysis to eposyandu_api;
grant usage, select on sequence public.analysis_result_version_seq to eposyandu_api;
alter table public.measurement_analysis enable row level security;
alter table public.analysis_scope_versions enable row level security;
alter table public.analysis_outbox enable row level security;
alter table public.dashboard_analysis enable row level security;
revoke all on function public.eposyandu_enqueue_analysis_job() from public;
grant execute on function public.eposyandu_enqueue_analysis_job() to eposyandu_api;
grant execute on function public.eposyandu_bump_analysis_scope(text) to eposyandu_api;
grant execute on function public.eposyandu_materialized_children_page(date,date,date,integer,integer,text,text,text,text,text,text,text,text) to eposyandu_api;
grant execute on function public.eposyandu_materialized_exclusive_breastfeeding_page(date,date,text,integer,integer,text,text,text,text,text) to eposyandu_api;
grant execute on function public.eposyandu_dashboard_snapshot(text,text,date,date,date,date,text,text) to eposyandu_api;

insert into public.schema_migrations (version, description)
values ('037', 'Python materialized analysis results and asynchronous outbox')
on conflict (version) do nothing;

commit;

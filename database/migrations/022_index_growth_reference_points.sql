begin;

-- Materialize the LMS arrays once. The dashboard and child lists can then use
-- an indexed point lookup instead of reparsing JSON for every measurement.
create table if not exists public.eposyandu_growth_lms_points (
  metric text not null,
  sex char(1) not null check (sex in ('L', 'P')),
  sample_index integer not null,
  l double precision not null,
  m double precision not null,
  s double precision not null,
  primary key (metric, sex, sample_index)
);

insert into public.eposyandu_growth_lms_points (
  metric,
  sex,
  sample_index,
  l,
  m,
  s
)
select
  source.metric,
  source.sex,
  point.ordinality::integer - 1,
  (point.value ->> 0)::double precision,
  (point.value ->> 1)::double precision,
  (point.value ->> 2)::double precision
from public.eposyandu_growth_lms source
cross join lateral jsonb_array_elements(source.values_json) with ordinality as point(value, ordinality)
on conflict (metric, sex, sample_index) do update
set
  l = excluded.l,
  m = excluded.m,
  s = excluded.s;

create or replace function public.eposyandu_lms(
  p_metric text,
  p_sex char(1),
  p_index integer
) returns double precision[]
language sql
stable
set search_path = public
as $$
  select array[p.l, p.m, p.s]
  from public.eposyandu_growth_lms_points p
  where p.metric = p_metric
    and p.sex = p_sex
    and p.sample_index = p_index
$$;

analyze public.eposyandu_growth_lms_points;

revoke all on table public.eposyandu_growth_lms_points from public;
grant select on table public.eposyandu_growth_lms_points to authenticated, service_role;

revoke all on function public.eposyandu_lms(text, char, integer) from public;
grant execute on function public.eposyandu_lms(text, char, integer) to authenticated, service_role;

insert into public.schema_migrations (version, description)
values ('022', 'materialize indexed growth reference points for dashboard calculations')
on conflict (version) do nothing;

commit;

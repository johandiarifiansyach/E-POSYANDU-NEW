begin;

-- Programme filters stop at completed month 59. WHO calculation tables and
-- growth charts still retain their 0–60-month reference data; this migration
-- changes only the selectable/reporting cohorts.
create or replace function public.eposyandu_age_group_match(
  p_age_group text,
  p_birth_date date,
  p_reference_date date,
  p_gestational_age_weeks smallint
) returns boolean
language sql
immutable
as $$
  with age_values as (
    select
      greatest(0, (extract(year from age(p_reference_date, p_birth_date)) * 12
        + extract(month from age(p_reference_date, p_birth_date)))::integer) as age_months,
      (p_reference_date - p_birth_date) as age_days
  )
  select case coalesce(nullif(trim(p_age_group), ''), '0-59')
    when 'newborn' then age_days between 0 and 28
    when 'newborn_premature' then age_days between 0 and 28
      and p_gestational_age_weeks > 0 and p_gestational_age_weeks < 37
    when '0-59' then age_months between 0 and 59
    when '0-5' then age_months between 0 and 5
    when '6' then age_months = 6
    when '0-11' then age_months between 0 and 11
    when '0-23' then age_months between 0 and 23
    when '6-11' then age_months between 6 and 11
    when '6-23' then age_months between 6 and 23
    when '12-23' then age_months between 12 and 23
    when '6-59' then age_months between 6 and 59
    when '12-59' then age_months between 12 and 59
    when '24-59' then age_months between 24 and 59
    else false
  end
  from age_values
  where p_birth_date is not null
    and p_reference_date is not null
    and p_birth_date <= p_reference_date;
$$;

-- Keep direct callers of change history on the same default cohort as the
-- Rust and frontend defaults.
create or replace function public.eposyandu_change_history_page(
  p_as_of date,
  p_page integer,
  p_size integer,
  p_age_group text default '0-59',
  p_search text default null,
  p_village text default null,
  p_posyandu text default null,
  p_role text default 'Ahli Gizi',
  p_scope_village text default null,
  p_scope_posyandu text default null
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scoped as (
    select l.id,
      coalesce(nullif(l.child_name, ''), c.name, '') as child_name,
      l.changed_by,
      l.changed_at,
      c.id as resolved_child_id
    from public.change_logs l
    join public.children c
      on c.id = coalesce(l.child_id, nullif(l.legacy_child_id, ''))
    where public.eposyandu_age_group_match(
        p_age_group, c.birth_date, p_as_of, c.gestational_age_weeks
      )
      and public.eposyandu_scope_match(
        c.village, c.posyandu,
        nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
        p_role, p_scope_village, p_scope_posyandu
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or coalesce(nullif(l.child_name, ''), c.name, '') ilike '%' || trim(p_search) || '%'
        or coalesce(c.national_id, '') ilike '%' || trim(p_search) || '%'
      )
  ), numbered as (
    select s.*,
      row_number() over (order by s.changed_at desc, s.id desc) as page_order
    from scoped s
  ), paged as (
    select n.*,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'field', e.field_name,
          'oldValue', e.old_value,
          'newValue', e.new_value
        ) order by e.id)
        from public.change_log_entries e
        where e.change_log_id = n.id
      ), '[]'::jsonb) as changes
    from numbered n
    where n.page_order > greatest(0, coalesce(p_page, 1) - 1)
      * greatest(1, least(coalesce(p_size, 10), 50))
      and n.page_order <= greatest(0, coalesce(p_page, 1) - 1)
      * greatest(1, least(coalesce(p_size, 10), 50))
      + greatest(1, least(coalesce(p_size, 10), 50))
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'data', jsonb_build_object(
          'childName', p.child_name,
          'changedBy', p.changed_by,
          'timestamp', p.changed_at,
          'changes', p.changes
        )
      ) order by p.page_order)
      from paged p
    ), '[]'::jsonb),
    'total', (select count(*) from scoped),
    'page', greatest(1, coalesce(p_page, 1)),
    'size', greatest(1, least(coalesce(p_size, 10), 50))
  );
$$;

insert into public.schema_migrations(version, description)
values ('041', 'age cohorts through 59 months and fixed MPASI cohort')
on conflict (version) do nothing;

commit;

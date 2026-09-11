begin;

-- The ASI table reports children who were six completed months old on their
-- measurement date inside the selected report month.  The dashboard's first
-- materialized implementation joined those rows to ``asi_children`` (the
-- cohort that is six months old on p_month_end), so a child measured on 8
-- September could disappear from the dashboard after turning seven before
-- 30 September.  Keep the denominator as the dashboard's six-month cohort,
-- but derive the numerator from the exact measurement-month cohort used by
-- eposyandu_materialized_exclusive_breastfeeding_page.  This makes the card
-- show the same babies as the table without changing the other dashboard
-- aggregates or the selected dashboard age filter.
do $$
declare
  function_definition text;
  corrected_definition text;
begin
  select pg_get_functiondef(p.oid)
    into function_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'eposyandu_dashboard_materialized_stats'
    and pg_get_function_identity_arguments(p.oid) =
      'p_month_start date, p_month_end date, p_previous_month_start date, p_previous_month_end date, p_age_group text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text';

  if function_definition is null then
    raise exception 'eposyandu_dashboard_materialized_stats is not installed';
  end if;

  corrected_definition := replace(
    function_definition,
    $needle$
  asi_latest as materialized (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id,
      a.exclusive_breastfeeding_status
    from public.measurements m
    join asi_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    left join public.measurement_analysis a on a.measurement_id = m.id
    where m.measurement_date >= c.birth_date
      and m.measurement_date <= p_month_end
      and public.eposyandu_age_months(c.birth_date, m.measurement_date) between 0 and 6
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ),
  asi_counts as (
    select count(*)::integer as target,
      count(*) filter (where a.exclusive_breastfeeding_status = 'Ya')::integer as exclusive
    from asi_children c
    left join asi_latest a on a.child_id = c.id
  )$needle$,
    $replacement$
  asi_latest as materialized (
    -- Keep one row per persisted positive measurement, exactly like the ASI
    -- table function. The table's total is a measurement-row total (and
    -- therefore remains stable even when a child has two recorded visits in
    -- one month); changing it to a distinct-child count would make the card
    -- disagree with the visible table again.
    select coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id,
      a.exclusive_breastfeeding_status
    from public.measurements m
    join scoped_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    join public.measurement_analysis a
      on a.measurement_id = m.id
     and a.exclusive_breastfeeding_status = 'Ya'
    where m.measurement_date between p_month_start and p_month_end
      and public.eposyandu_age_group_match(
        '6', c.birth_date, m.measurement_date, c.gestational_age_weeks
      )
  ),
  asi_counts as (
    select
      (select count(*)::integer from asi_children) as target,
      (select count(*)::integer from asi_latest) as exclusive
  )$replacement$
  );

  if corrected_definition = function_definition then
    raise exception 'ASI dashboard aggregate block was not found';
  end if;
  execute corrected_definition;
end
$$;

insert into public.schema_migrations(version, description)
values ('052', 'align dashboard ASI numerator with six-month measurement table')
on conflict (version) do nothing;

commit;

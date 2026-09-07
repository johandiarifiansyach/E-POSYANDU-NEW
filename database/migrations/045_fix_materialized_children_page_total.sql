begin;

-- Migration 039 accidentally passed an integer fallback to COALESCE for a
-- jsonb value. PostgreSQL rejects the function at runtime, which makes the
-- Rust read path fall back to a page marked analysisPending even though
-- measurement_analysis is fully populated. Recreate the already-installed
-- function from its definition so this correction stays small and remains
-- safe for rolling deployments.
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
    and p.proname = 'eposyandu_materialized_children_page'
    and pg_get_function_identity_arguments(p.oid) =
      'p_as_of date, p_measurement_start date, p_measurement_end date, p_page integer, p_size integer, p_sort text, p_view text, p_search text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text';

  if function_definition is null then
    raise exception 'Fungsi eposyandu_materialized_children_page belum tersedia.';
  end if;

  corrected_definition := replace(
    function_definition,
    'coalesce(v_result->''total'', 0)',
    'coalesce(v_result->''total'', ''0''::jsonb)'
  );

  if corrected_definition = function_definition then
    -- The function may already contain the corrected expression after a
    -- partially completed rollout. Keep the migration idempotent.
    if position('coalesce(v_result->''total'', ''0''::jsonb)' in function_definition) = 0 then
      raise exception 'Ekspresi total pada fungsi materialized children tidak ditemukan.';
    end if;
  else
    execute corrected_definition;
  end if;
end
$$;

insert into public.schema_migrations(version, description)
values ('045', 'fix jsonb total fallback in materialized children page')
on conflict (version) do nothing;

commit;

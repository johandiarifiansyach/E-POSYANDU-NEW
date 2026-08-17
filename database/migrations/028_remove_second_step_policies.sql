begin;

-- Compatibility cleanup for an environment that may already have applied the
-- earlier version of migration 027. Authentication remains centralized in the
-- Worker and direct browser RPC execution remains revoked by migration 027.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'app_users',
    'children',
    'measurements',
    'mpasi_logs',
    'pmt_programs',
    'pmt_monitorings',
    'change_logs',
    'change_log_entries',
    'sync_tombstones'
  ]
  loop
    execute format('drop policy if exists authenticated_aal2_only on public.%I', table_name);
  end loop;
end
$$;

insert into public.schema_migrations (version, description)
values ('028', 'remove legacy second-step authentication policies')
on conflict (version) do nothing;

commit;

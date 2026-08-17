begin;

-- Defense in depth for any future authenticated table grants. The application
-- itself uses service_role only behind the Rust Worker, where AAL2 is checked
-- before authorization. These restrictive policies prevent an AAL1 JWT from
-- using an accidentally restored direct table grant.
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
    execute format(
      'create policy authenticated_aal2_only on public.%I as restrictive for all to authenticated using (coalesce((select auth.jwt()->>''aal''), ''aal1'') = ''aal2'') with check (coalesce((select auth.jwt()->>''aal''), ''aal1'') = ''aal2'')',
      table_name
    );
  end loop;
end
$$;

-- Direct browser fallbacks were removed when sessions moved to HttpOnly
-- cookies. Keep these older RPCs for rollback/service-role compatibility, but
-- do not allow browser JWTs to bypass the Worker, Turnstile, audit, or MFA.
revoke execute on function public.eposyandu_current_access_profile() from authenticated;
revoke execute on function public.eposyandu_self_children_page(date, date, date, integer, integer, text, text, text, text, text) from authenticated;
revoke execute on function public.eposyandu_self_problem_children_page(date, date, text, integer, integer, text, text, text, text) from authenticated;
revoke execute on function public.eposyandu_self_exclusive_breastfeeding_page(date, date, text, integer, integer, text, text) from authenticated;
revoke execute on function public.eposyandu_self_dashboard_stats(date, date, date, date, text, text) from authenticated;
revoke execute on function public.eposyandu_self_child_detail(text) from authenticated;
revoke execute on function public.eposyandu_self_sync_measurement_batch(jsonb) from authenticated;

insert into public.schema_migrations (version, description)
values ('027', 'require AAL2 and close direct authenticated browser fallback RPCs')
on conflict (version) do nothing;

commit;

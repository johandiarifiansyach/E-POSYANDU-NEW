begin;

-- Browser sessions now use an opaque HttpOnly cookie and all authorization is
-- enforced by the Rust Worker. Keep the older RPCs for service-role rollback
-- compatibility, but do not let a browser JWT bypass the Worker, Turnstile,
-- rate limiter, request validation, or operational audit.
revoke execute on function public.eposyandu_current_access_profile() from authenticated;
revoke execute on function public.eposyandu_self_children_page(date, date, date, integer, integer, text, text, text, text, text) from authenticated;
revoke execute on function public.eposyandu_self_problem_children_page(date, date, text, integer, integer, text, text, text, text) from authenticated;
revoke execute on function public.eposyandu_self_exclusive_breastfeeding_page(date, date, text, integer, integer, text, text) from authenticated;
revoke execute on function public.eposyandu_self_dashboard_stats(date, date, date, date, text, text) from authenticated;
revoke execute on function public.eposyandu_self_child_detail(text) from authenticated;
revoke execute on function public.eposyandu_self_sync_measurement_batch(jsonb) from authenticated;

insert into public.schema_migrations (version, description)
values ('027', 'close direct authenticated browser fallback RPCs')
on conflict (version) do nothing;

commit;

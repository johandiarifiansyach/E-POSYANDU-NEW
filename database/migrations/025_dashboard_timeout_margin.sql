begin;

-- Keep enough room for a cold Supabase connection without making normal
-- dashboard requests wait indefinitely.
alter function public.eposyandu_dashboard_stats(
  date,
  date,
  date,
  date,
  text,
  text,
  text,
  text,
  text
)
set statement_timeout = '15s';

insert into public.schema_migrations (version, description)
values ('025', 'dashboard statement timeout margin')
on conflict (version) do nothing;

commit;

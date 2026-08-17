begin;

-- A cold database connection can need more time than the default API budget.
-- Keep the dashboard bounded without cancelling a valid aggregate too early.
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
set statement_timeout = '8s';

insert into public.schema_migrations (version, description)
values ('024', 'dashboard statement timeout budget')
on conflict (version) do nothing;

commit;

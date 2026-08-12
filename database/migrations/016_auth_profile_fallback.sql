begin;

create or replace function public.eposyandu_current_access_profile()
returns table (
  user_id uuid,
  email text,
  role text,
  village text,
  posyandu text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    users.user_id,
    users.email,
    users.role,
    users.village,
    users.posyandu
  from public.app_users users
  where users.user_id = auth.uid()
    and users.active
  limit 1;
$$;

revoke all on function public.eposyandu_current_access_profile() from public, anon;
grant execute on function public.eposyandu_current_access_profile() to authenticated, service_role;

insert into public.schema_migrations (version, description)
values ('016', 'restricted self-profile RPC for authentication fallback')
on conflict (version) do nothing;

commit;

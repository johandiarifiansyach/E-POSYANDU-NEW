begin;

alter table public.audit_events
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.audit_events
  drop constraint if exists audit_events_action_check;
alter table public.audit_events
  add constraint audit_events_action_check check (
    action in (
      'create',
      'update',
      'delete',
      'login_success',
      'login_failure',
      'export',
      'role_change'
    )
  ) not valid;
alter table public.audit_events
  validate constraint audit_events_action_check;

alter table public.audit_events
  drop constraint if exists audit_events_resource_check;
alter table public.audit_events
  add constraint audit_events_resource_check check (
    resource in (
      'children',
      'measurements',
      'mpasi_logs',
      'pmt_programs',
      'pmt_monitorings',
      'change_logs',
      'authentication',
      'sigizi_measurement_export',
      'app_users'
    )
  ) not valid;
alter table public.audit_events
  validate constraint audit_events_resource_check;

create or replace function public.eposyandu_audit_app_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_events (
    request_id,
    actor_user_id,
    actor_role,
    action,
    resource,
    document_id,
    village,
    posyandu,
    before_data,
    after_data,
    metadata
  )
  values (
    format('db-role-%s-%s', txid_current(), new.user_id),
    coalesce(auth.uid()::text, current_user),
    'database',
    'role_change',
    'app_users',
    new.user_id::text,
    new.village,
    new.posyandu,
    jsonb_build_object(
      'role', old.role,
      'village', old.village,
      'posyandu', old.posyandu,
      'active', old.active
    ),
    jsonb_build_object(
      'role', new.role,
      'village', new.village,
      'posyandu', new.posyandu,
      'active', new.active
    ),
    jsonb_build_object('source', 'database_trigger')
  );

  return new;
end;
$$;

drop trigger if exists app_users_audit_role_change on public.app_users;
create trigger app_users_audit_role_change
after update of role, village, posyandu, active on public.app_users
for each row
when (
  old.role is distinct from new.role
  or old.village is distinct from new.village
  or old.posyandu is distinct from new.posyandu
  or old.active is distinct from new.active
)
execute function public.eposyandu_audit_app_user_role_change();

revoke all on function public.eposyandu_audit_app_user_role_change() from public;

insert into public.schema_migrations (version, description)
values ('011', 'operational login export and role audit')
on conflict (version) do nothing;

commit;

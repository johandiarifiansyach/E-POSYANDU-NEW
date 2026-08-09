begin;

create table if not exists public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'import_validation',
    'nutrition_report',
    'export_file',
    'system_sync'
  )),
  status text not null default 'queued' check (status in (
    'queued',
    'processing',
    'completed',
    'failed',
    'cancelled'
  )),
  progress smallint not null default 0 check (progress between 0 and 100),
  owner_user_id uuid not null,
  actor_role text not null,
  village text,
  posyandu text,
  idempotency_key text not null,
  request_id text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  object_key text,
  file_name text,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  version bigint not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default timezone('utc', now()) + interval '7 days',
  unique (owner_user_id, idempotency_key)
);

create index if not exists idx_background_jobs_owner_created
  on public.background_jobs (owner_user_id, created_at desc);
create index if not exists idx_background_jobs_status_created
  on public.background_jobs (status, created_at);
create index if not exists idx_background_jobs_expires
  on public.background_jobs (expires_at);

create or replace function public.eposyandu_touch_background_job()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := timezone('utc', now());
  new.version := old.version + 1;
  if new.status = 'processing' and old.status is distinct from new.status then
    new.started_at := coalesce(new.started_at, timezone('utc', now()));
  end if;
  if new.status in ('completed', 'failed', 'cancelled')
     and old.status is distinct from new.status then
    new.completed_at := coalesce(new.completed_at, timezone('utc', now()));
  end if;
  return new;
end;
$$;

drop trigger if exists background_jobs_touch on public.background_jobs;
create trigger background_jobs_touch
before update on public.background_jobs
for each row execute function public.eposyandu_touch_background_job();

alter table public.background_jobs enable row level security;
alter table public.background_jobs force row level security;

revoke all on table public.background_jobs from anon, authenticated;
grant all on table public.background_jobs to service_role;

revoke all on function public.eposyandu_touch_background_job() from public;
grant execute on function public.eposyandu_touch_background_job() to service_role;

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
      'role_change',
      'job_create',
      'job_start',
      'job_complete',
      'job_fail'
    )
  ) not valid;
alter table public.audit_events validate constraint audit_events_action_check;

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
      'app_users',
      'background_jobs',
      'import_validation',
      'nutrition_report',
      'export_file',
      'system_sync'
    )
  ) not valid;
alter table public.audit_events validate constraint audit_events_resource_check;

insert into public.schema_migrations (version, description)
values ('015', 'background Queue and gRPC jobs with private result metadata')
on conflict (version) do nothing;

commit;

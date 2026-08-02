begin;

alter table public.children add column if not exists version bigint not null default 1;
alter table public.measurements add column if not exists version bigint not null default 1;
alter table public.mpasi_logs add column if not exists version bigint not null default 1;
alter table public.pmt_programs add column if not exists version bigint not null default 1;
alter table public.pmt_monitorings add column if not exists version bigint not null default 1;
alter table public.change_logs add column if not exists version bigint not null default 1;

create or replace function public.eposyandu_bump_version()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

drop trigger if exists children_bump_version on public.children;
create trigger children_bump_version
before update on public.children
for each row execute function public.eposyandu_bump_version();

drop trigger if exists measurements_bump_version on public.measurements;
create trigger measurements_bump_version
before update on public.measurements
for each row execute function public.eposyandu_bump_version();

drop trigger if exists mpasi_logs_bump_version on public.mpasi_logs;
create trigger mpasi_logs_bump_version
before update on public.mpasi_logs
for each row execute function public.eposyandu_bump_version();

drop trigger if exists pmt_programs_bump_version on public.pmt_programs;
create trigger pmt_programs_bump_version
before update on public.pmt_programs
for each row execute function public.eposyandu_bump_version();

drop trigger if exists pmt_monitorings_bump_version on public.pmt_monitorings;
create trigger pmt_monitorings_bump_version
before update on public.pmt_monitorings
for each row execute function public.eposyandu_bump_version();

drop trigger if exists change_logs_bump_version on public.change_logs;
create trigger change_logs_bump_version
before update on public.change_logs
for each row execute function public.eposyandu_bump_version();

create table if not exists public.schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default timezone('utc', now())
);

insert into public.schema_migrations (version, description)
values
  ('001', 'native schema'),
  ('002', 'sync tombstones'),
  ('003', 'application users'),
  ('004', 'username login'),
  ('005', 'posyandu user seed'),
  ('006', 'cloudflare edge API functions'),
  ('007', 'Sigizi measurement export'),
  ('008', 'lock legacy documents'),
  ('009', 'security hardening and RLS'),
  ('010', 'sync versioning and audit')
on conflict (version) do nothing;

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  request_id text not null,
  idempotency_key text,
  actor_user_id text not null,
  actor_role text not null,
  action text not null check (action in ('create', 'update', 'delete')),
  resource text not null check (resource in ('children', 'measurements', 'mpasi_logs', 'pmt_programs', 'change_logs')),
  document_id text not null,
  village text,
  posyandu text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_audit_events_idempotency
  on public.audit_events (idempotency_key, action, resource, document_id);
create index if not exists idx_audit_events_document
  on public.audit_events (resource, document_id, created_at desc);
create index if not exists idx_audit_events_created_at
  on public.audit_events (created_at desc);

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

revoke all on table public.audit_events from anon, authenticated;
grant all on table public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;

revoke all on table public.schema_migrations from anon, authenticated;
grant select on table public.schema_migrations to service_role;

revoke all on function public.eposyandu_bump_version() from public;
grant execute on function public.eposyandu_bump_version() to service_role;

commit;

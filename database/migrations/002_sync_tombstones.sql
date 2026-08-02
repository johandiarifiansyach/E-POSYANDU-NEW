begin;

create table if not exists sync_tombstones (
  resource text not null check (resource in ('children', 'measurements', 'mpasi_logs', 'pmt_programs', 'change_logs')),
  document_id text not null,
  village text,
  posyandu text,
  deleted_at timestamptz not null default timezone('utc', now()),
  primary key (resource, document_id)
);

alter table sync_tombstones add column if not exists village text;
alter table sync_tombstones add column if not exists posyandu text;

create index if not exists idx_sync_tombstones_resource_deleted_at
  on sync_tombstones (resource, deleted_at);
create index if not exists idx_sync_tombstones_scope_deleted_at
  on sync_tombstones (resource, village, posyandu, deleted_at);

alter table sync_tombstones enable row level security;

commit;

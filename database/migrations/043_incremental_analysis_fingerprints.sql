begin;

-- Keep the original source_fingerprint column for rolling compatibility, but
-- make the incremental contract explicit.  Existing projections are safe to
-- reuse because their fingerprint is already a deterministic representation
-- of the raw input used for that result.
alter table public.measurement_analysis
  add column if not exists input_hash text;
alter table public.measurement_analysis
  add column if not exists source_version bigint;

update public.measurement_analysis
set input_hash = source_fingerprint
where input_hash is null;

update public.measurement_analysis
set source_version = 1
where source_version is null;

alter table public.measurement_analysis
  alter column input_hash set default '';
alter table public.measurement_analysis
  alter column source_version set default 1;
alter table public.measurement_analysis
  alter column input_hash set not null;
alter table public.measurement_analysis
  alter column source_version set not null;

create index if not exists idx_measurement_analysis_child_input_hash
  on public.measurement_analysis(child_id, input_hash);
create index if not exists idx_measurement_analysis_child_source_version
  on public.measurement_analysis(child_id, source_version);

comment on column public.measurement_analysis.input_hash is
  'Deterministic hash of the child-scoped analysis inputs; unchanged hashes skip Python recalculation.';
comment on column public.measurement_analysis.source_version is
  'Newest raw source version participating in this child projection.';

insert into public.schema_migrations(version, description)
values ('043', 'incremental Python analysis input hashes and source versions')
on conflict (version) do nothing;

commit;

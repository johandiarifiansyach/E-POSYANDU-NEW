begin;

-- Hot-path indexes for the materialized read model and the write-side queue.
-- The partial predicates keep indexes small and make the common active/pending
-- queries selective without changing any Python-derived value.
create index if not exists idx_children_active_scope_birth_id
  on public.children (village, posyandu, birth_date, id)
  where deleted_at is null and birth_date is not null;

create index if not exists idx_pmt_programs_active_child_distribution
  on public.pmt_programs (child_id, distribution_date desc, id desc)
  where status = 'Aktif';

create index if not exists idx_analysis_outbox_pending_claim
  on public.analysis_outbox (available_at, id)
  where status = 'pending';

create index if not exists idx_analysis_outbox_processing_lease
  on public.analysis_outbox (updated_at, id)
  where status = 'processing';

-- analysis_outbox is intentionally high-churn. Lower thresholds let
-- PostgreSQL's autovacuum reclaim dead queue rows and refresh planner
-- statistics before bloat affects the worker claim query.
alter table public.analysis_outbox set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 50,
  autovacuum_analyze_threshold = 50
);

alter table public.measurement_analysis set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 100,
  autovacuum_analyze_threshold = 100
);

analyze public.children;
analyze public.pmt_programs;
analyze public.analysis_outbox;
analyze public.measurement_analysis;

insert into public.schema_migrations(version, description)
values ('048', 'PostgreSQL hot-path partial indexes and autovacuum tuning')
on conflict (version) do nothing;

commit;

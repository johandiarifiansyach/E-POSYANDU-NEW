begin;

-- Read-path indexes for the Rust gateway.  These indexes complement the
-- materialized Python projections from migrations 037/043: Rust can filter
-- and paginate a small page without scanning the complete population or the
-- complete measurement history.  All definitions are idempotent so a rolling
-- migration can be retried safely.
create index if not exists idx_children_active_created_id
  on public.children (created_at desc, id)
  where deleted_at is null;

create index if not exists idx_children_active_scope_created_id
  on public.children (village, posyandu, created_at desc, id)
  where deleted_at is null;

create index if not exists idx_children_active_name_id
  on public.children (lower(name), id)
  where deleted_at is null;

create index if not exists idx_children_active_national_id
  on public.children (national_id, id)
  where deleted_at is null;

create index if not exists idx_measurements_child_date_created_id
  on public.measurements (child_id, measurement_date desc, created_at desc, id desc);

create index if not exists idx_measurements_legacy_child_date_created_id
  on public.measurements (legacy_child_id, measurement_date desc, created_at desc, id desc);

create index if not exists idx_measurements_date_child_id
  on public.measurements (measurement_date desc, child_id, id desc);

create index if not exists idx_mpasi_logs_child_date_created_id
  on public.mpasi_logs (child_id, monitoring_date desc, created_at desc, id desc);

create index if not exists idx_mpasi_logs_date_child_id
  on public.mpasi_logs (monitoring_date desc, child_id, id desc);

create index if not exists idx_pmt_programs_child_distribution_id
  on public.pmt_programs (child_id, distribution_date desc, id desc);

create index if not exists idx_change_logs_child_changed_id
  on public.change_logs (child_id, changed_at desc, id desc);

create index if not exists idx_change_log_entries_log_id
  on public.change_log_entries (change_log_id, id);

create index if not exists idx_measurement_analysis_child_version
  on public.measurement_analysis (child_id, analysis_version desc, measurement_id);

create index if not exists idx_dashboard_analysis_scope_period
  on public.dashboard_analysis (
    scope_key,
    month_start,
    month_end,
    previous_month_start,
    previous_month_end,
    source_scope_version,
    calculated_at desc
  );

-- Refresh planner statistics after the new indexes are available.  This is
-- intentionally metadata-only work; no WHO or Python recalculation occurs.
analyze public.children;
analyze public.measurements;
analyze public.mpasi_logs;
analyze public.pmt_programs;
analyze public.change_logs;
analyze public.change_log_entries;
analyze public.measurement_analysis;
analyze public.dashboard_analysis;

insert into public.schema_migrations(version, description)
values ('044', 'Rust read-path indexes and materialized projection lookup support')
on conflict (version) do nothing;

commit;

begin;

-- A transient worker/database problem used to move jobs to ``failed`` after
-- five attempts, where they remained forever even after the service was
-- repaired.  Requeue those child-scoped projections once during rollout so
-- Python can rebuild the missing WHO/status values.  The worker also performs
-- the same recovery once per process start for failures that happen between
-- migrations; this migration makes an already-running deployment recover as
-- soon as the database migration is applied.
update public.analysis_outbox
set status = 'pending',
    attempts = 0,
    available_at = timezone('utc', now()),
    last_error = null,
    updated_at = timezone('utc', now())
where status = 'failed'
  and child_id is not null;

insert into public.schema_migrations(version, description)
values ('047', 'recover failed child analysis jobs after transient worker errors')
on conflict (version) do nothing;

commit;

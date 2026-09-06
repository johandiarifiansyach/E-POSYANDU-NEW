begin;

-- Migration 037 intentionally made the initial calculation asynchronous, but
-- it also inserted one queue row per measurement and one per child.  A child
-- job already rebuilds that child's complete projection, so processing both
-- sets repeats the same work.  Resolve legacy measurement rows to their
-- canonical child and retain only the newest pending job for each child.
update public.analysis_outbox q
set child_id = coalesce(m.child_id, nullif(m.legacy_child_id, '')),
    updated_at = timezone('utc', now())
from public.measurements m
where q.entity_type = 'measurements'
  and q.entity_id = m.id
  and q.child_id is null;

-- Orphaned measurements cannot produce a child projection.  Mark these stale
-- backfill rows complete instead of making the worker revisit them forever.
update public.analysis_outbox q
set status = 'done',
    last_error = 'skipped: measurement has no linked child',
    updated_at = timezone('utc', now())
where q.status = 'pending'
  and q.entity_type = 'measurements'
  and q.child_id is null;

with pending as (
  select q.id, q.child_id,
         row_number() over (
           partition by q.child_id order by q.id desc
         ) as position
  from public.analysis_outbox q
  where q.status = 'pending' and q.child_id is not null
), collapsed as (
  update public.analysis_outbox q
  set status = 'done',
      last_error = 'coalesced: newer child analysis job retained',
      updated_at = timezone('utc', now())
  from pending p
  where q.id = p.id
    and p.position > 1
    and not exists (
      select 1
      from public.analysis_outbox active
      where active.status = 'processing'
        and active.child_id = p.child_id
    )
  returning q.id
)
select count(*) from collapsed;

create index if not exists idx_analysis_outbox_child_claim
  on public.analysis_outbox(child_id, status, available_at, id);

insert into public.schema_migrations (version, description)
values ('038', 'coalesce redundant Python analysis backfill jobs')
on conflict (version) do nothing;

commit;

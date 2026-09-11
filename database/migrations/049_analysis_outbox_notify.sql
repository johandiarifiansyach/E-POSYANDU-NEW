begin;

-- Wake the Rust/PyO3 scheduler after the source transaction commits.  The
-- notification contains only the queue id; the worker always claims the
-- durable row through FOR UPDATE SKIP LOCKED and never trusts the payload.
create or replace function public.eposyandu_notify_analysis_outbox()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_notify(
    'e_posyandu_analysis_outbox',
    json_build_object('id', new.id, 'entity_type', new.entity_type)::text
  );
  return new;
end;
$$;

drop trigger if exists analysis_outbox_notify_worker on public.analysis_outbox;
create trigger analysis_outbox_notify_worker
after insert on public.analysis_outbox
for each row execute function public.eposyandu_notify_analysis_outbox();

insert into public.schema_migrations(version, description)
values ('049', 'LISTEN/NOTIFY wake-up for analysis outbox workers')
on conflict (version) do nothing;

commit;

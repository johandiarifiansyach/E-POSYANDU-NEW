create table if not exists public.documents (
  table_name text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (table_name, id)
);

create index if not exists idx_documents_table_name on public.documents (table_name);
create index if not exists idx_documents_data_gin on public.documents using gin (data);

alter table public.documents enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and policyname = 'Allow read for anon and authenticated'
  ) then
    create policy "Allow read for anon and authenticated"
      on public.documents
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and policyname = 'Allow write for anon and authenticated'
  ) then
    create policy "Allow write for anon and authenticated"
      on public.documents
      for all
      to anon, authenticated
      using (true)
      with check (true);
  end if;
end
$$;

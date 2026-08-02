begin;

-- Tabel JSONB lama menyimpan salinan data balita untuk rollback migrasi.
-- Tabel native dan Worker Rust adalah satu-satunya jalur aplikasi produksi.
alter table public.documents enable row level security;
drop policy if exists "Allow read for anon and authenticated" on public.documents;
drop policy if exists "Allow write for anon and authenticated" on public.documents;
revoke all on table public.documents from public, anon, authenticated;

commit;

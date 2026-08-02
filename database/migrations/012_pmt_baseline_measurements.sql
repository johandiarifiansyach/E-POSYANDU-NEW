begin;

alter table public.pmt_programs
  add column if not exists initial_measurement_date date,
  add column if not exists initial_weight_kg numeric(5,2),
  add column if not exists initial_height_cm numeric(5,1);

comment on column public.pmt_programs.initial_measurement_date is
  'Tanggal pengukuran yang menjadi nilai awal program PMT.';
comment on column public.pmt_programs.initial_weight_kg is
  'Berat badan awal saat program PMT dimulai.';
comment on column public.pmt_programs.initial_height_cm is
  'Panjang atau tinggi badan awal saat program PMT dimulai.';

insert into public.schema_migrations (version, description)
values ('012', 'PMT baseline measurement fields')
on conflict (version) do nothing;

commit;

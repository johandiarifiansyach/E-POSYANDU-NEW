begin;

create table if not exists children (
  id text primary key,
  name text not null,
  national_id text not null default '',
  child_order smallint,
  birth_date date,
  birth_date_raw text not null,
  sex char(1) not null check (sex in ('L', 'P')),
  family_card_number text not null default '',
  has_family_card boolean not null default false,
  has_national_id boolean not null default false,
  gestational_age_weeks smallint,
  birth_weight_kg numeric(5,2),
  birth_length_cm numeric(5,1),
  birth_head_circumference_cm numeric(5,1),
  has_maternal_child_book boolean not null default false,
  has_small_baby_book boolean not null default false,
  early_breastfeeding_initiation boolean not null default false,
  parent_name text not null default '',
  parent_national_id text not null default '',
  parent_phone text not null default '',
  address text not null default '',
  rt text not null default '',
  rw text not null default '',
  village text not null,
  posyandu text not null,
  current_weight_kg numeric(5,2),
  current_height_cm numeric(5,1),
  current_mid_upper_arm_circumference_cm numeric(5,1),
  current_head_circumference_cm numeric(5,1),
  last_measurement_date date,
  created_at timestamptz not null default timezone('utc', now()),
  created_by text,
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  delete_reason text,
  death_date date,
  death_cause text,
  death_location text
);

create index if not exists idx_children_location on children (village, posyandu);
create index if not exists idx_children_birth_date on children (birth_date);
create index if not exists idx_children_deleted_at on children (deleted_at);
create index if not exists idx_children_updated_at on children (updated_at);

create table if not exists measurements (
  id text primary key,
  child_id text references children(id) on delete set null,
  legacy_child_id text not null,
  legacy_child_name text not null default '',
  legacy_village text not null default '',
  legacy_posyandu text not null default '',
  measurement_date date,
  measurement_date_raw text not null,
  weight_kg numeric(5,2),
  height_cm numeric(5,1),
  head_circumference_cm numeric(5,1),
  mid_upper_arm_circumference_cm numeric(5,1),
  edema text not null default 'Tidak',
  mother_class_attendance text not null default 'Tidak',
  mbg text not null default 'Tidak',
  vitamin_a text not null default 'Tidak',
  exclusive_breastfeeding text not null default 'Tidak',
  measurement_method text not null default '',
  weight_gain_status char(1) not null default 'B' check (weight_gain_status in ('N', 'T', 'B', 'O')),
  age_in_months smallint,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_measurements_child_date on measurements (child_id, measurement_date desc);
create index if not exists idx_measurements_date on measurements (measurement_date);
create index if not exists idx_measurements_updated_at on measurements (updated_at);

create table if not exists mpasi_logs (
  id text primary key,
  child_id text references children(id) on delete set null,
  legacy_child_id text not null,
  legacy_child_name text not null default '',
  monitoring_date date not null,
  breastfeeding text not null default 'Tidak',
  staple_food boolean not null default false,
  legumes boolean not null default false,
  dairy boolean not null default false,
  meat boolean not null default false,
  eggs boolean not null default false,
  vitamin_a_fruit_vegetable boolean not null default false,
  other_fruit_vegetable boolean not null default false,
  nutrition_intervention text not null default 'Tidak',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_mpasi_logs_child_date on mpasi_logs (child_id, monitoring_date desc);
create index if not exists idx_mpasi_logs_date on mpasi_logs (monitoring_date);
create index if not exists idx_mpasi_logs_updated_at on mpasi_logs (updated_at);

create table if not exists pmt_programs (
  id text primary key,
  child_id text references children(id) on delete set null,
  legacy_child_id text not null,
  legacy_child_name text not null default '',
  category text not null check (category in ('Wasting', 'Underweight', 'TidakNaik')),
  pmt_type text not null check (pmt_type in ('Pabrikan', 'Lokal')),
  funding_source text not null,
  partner text,
  other_partner text,
  cycle_number smallint not null default 1 check (cycle_number > 0),
  follows_guidelines text not null default 'Ya',
  distribution_date date not null,
  initial_measurement_date date,
  initial_weight_kg numeric(5,2),
  initial_height_cm numeric(5,1),
  status text not null default 'Aktif' check (status in ('Aktif', 'Selesai')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_pmt_programs_child on pmt_programs (child_id);
create index if not exists idx_pmt_programs_status on pmt_programs (status);
create index if not exists idx_pmt_programs_updated_at on pmt_programs (updated_at);

create table if not exists pmt_monitorings (
  program_id text not null references pmt_programs(id) on delete cascade,
  week_number smallint not null check (week_number > 0),
  monitoring_date date,
  weight_kg numeric(5,2),
  height_cm numeric(5,1),
  measurement_method text not null default '',
  consumed_days boolean[] not null default array[false, false, false, false, false, false, false]::boolean[],
  health_monitoring text not null default 'Ada',
  follow_up text not null default 'Dilanjutkan',
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (program_id, week_number)
);

create table if not exists change_logs (
  id text primary key,
  child_id text references children(id) on delete set null,
  legacy_child_id text,
  child_name text not null default '',
  changed_by text not null default '',
  changed_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_change_logs_child on change_logs (child_id);
create index if not exists idx_change_logs_changed_at on change_logs (changed_at desc);

create table if not exists change_log_entries (
  id bigserial primary key,
  change_log_id text not null references change_logs(id) on delete cascade,
  field_name text not null,
  old_value jsonb,
  new_value jsonb
);

create index if not exists idx_change_log_entries_log on change_log_entries (change_log_id);

alter table children enable row level security;
alter table measurements enable row level security;
alter table mpasi_logs enable row level security;
alter table pmt_programs enable row level security;
alter table pmt_monitorings enable row level security;
alter table change_logs enable row level security;
alter table change_log_entries enable row level security;

commit;

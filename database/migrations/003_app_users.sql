begin;

create table if not exists app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('Kader Posyandu', 'Bidan Desa', 'Ahli Gizi')),
  village text,
  posyandu text,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    (role = 'Ahli Gizi' and village is null and posyandu is null)
    or (role = 'Bidan Desa' and village is not null and posyandu is null)
    or (role = 'Kader Posyandu' and village is not null and posyandu is not null)
  )
);

alter table app_users enable row level security;

commit;

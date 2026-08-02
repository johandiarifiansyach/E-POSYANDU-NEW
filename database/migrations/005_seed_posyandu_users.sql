begin;

with salak_accounts as (
  select
    id as user_id,
    lower(email) as email,
    substring(lower(email) from '^salak([0-9]+)@posyandu\.com$')::integer as salak_number
  from auth.users
  where lower(email) ~ '^salak[0-9]+@posyandu\.com$'
), mapped_accounts as (
  select
    user_id,
    split_part(email, '@', 1) as username,
    email,
    salak_number,
    case
      when salak_number between 1 and 17 or salak_number = 99 then 'Desa Gumukmas'
      when salak_number between 18 and 31 or salak_number = 98 then 'Desa Menampu'
      when salak_number between 32 and 42 then 'Desa Mayangan'
      when salak_number between 43 and 52 then 'Desa Kepanjen'
      when salak_number between 53 and 61 then 'Desa Purwoasri'
      else null
    end as village
  from salak_accounts
)
insert into public.app_users (
  user_id, username, email, role, village, posyandu, active
)
select
  user_id,
  username,
  email,
  'Kader Posyandu',
  village,
  'SALAK ' || salak_number,
  true
from mapped_accounts
where village is not null
on conflict (user_id) do update set
  username = excluded.username,
  email = excluded.email,
  role = excluded.role,
  village = excluded.village,
  posyandu = excluded.posyandu,
  active = true,
  updated_at = timezone('utc', now());

with village_accounts (email, username, village) as (
  values
    ('desagumukmas@posyandu.com', 'desagumukmas', 'Desa Gumukmas'),
    ('desakepanjen@posyandu.com', 'desakepanjen', 'Desa Kepanjen'),
    ('desamayangan@posyandu.com', 'desamayangan', 'Desa Mayangan'),
    ('desamenampu@posyandu.com', 'desamenampu', 'Desa Menampu'),
    ('desapurwoasri@posyandu.com', 'desapurwoasri', 'Desa Purwoasri')
)
insert into public.app_users (
  user_id, username, email, role, village, posyandu, active
)
select
  users.id,
  accounts.username,
  accounts.email,
  'Bidan Desa',
  accounts.village,
  null,
  true
from village_accounts accounts
join auth.users users on lower(users.email) = accounts.email
on conflict (user_id) do update set
  username = excluded.username,
  email = excluded.email,
  role = excluded.role,
  village = excluded.village,
  posyandu = null,
  active = true,
  updated_at = timezone('utc', now());

insert into public.app_users (
  user_id, username, email, role, village, posyandu, active
)
select
  id,
  'gizi',
  'gizipuskesmasgumukmas@gmail.com',
  'Ahli Gizi',
  null,
  null,
  true
from auth.users
where lower(email) = 'gizipuskesmasgumukmas@gmail.com'
on conflict (user_id) do update set
  username = excluded.username,
  email = excluded.email,
  role = excluded.role,
  village = null,
  posyandu = null,
  active = true,
  updated_at = timezone('utc', now());

commit;

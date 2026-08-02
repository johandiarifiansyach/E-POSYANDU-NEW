begin;

alter table app_users add column if not exists username text;
alter table app_users add column if not exists email text;

create unique index if not exists idx_app_users_username_unique
  on app_users (lower(username))
  where username is not null;
create unique index if not exists idx_app_users_email_unique
  on app_users (lower(email))
  where email is not null;

commit;

begin;

-- Tahap pertama migrasi autentikasi Oracle: siapkan penyimpanan native tanpa
-- menyalin atau mengubah role, desa, posyandu, access_mode, maupun active pada
-- public.app_users. Pengisian tabel dilakukan oleh identity-service pada tahap
-- berikutnya setelah alur migrasi kredensial diuji di staging.

create table if not exists public.auth_credentials (
  user_id uuid primary key references public.app_users(user_id) on delete cascade,
  password_hash text not null,
  password_scheme text not null default 'argon2id'
    check (password_scheme in ('argon2id')),
  password_changed_at timestamptz not null default timezone('utc', now()),
  last_password_login_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  session_token_hash text not null unique,
  mfa_verified boolean not null default false,
  mfa_verified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent_hash text
);

create index if not exists idx_auth_sessions_user_active
  on public.auth_sessions (user_id, last_seen_at desc)
  where revoked_at is null;
create index if not exists idx_auth_sessions_expiry
  on public.auth_sessions (expires_at)
  where revoked_at is null;

create table if not exists public.auth_session_revisions (
  user_id uuid primary key references public.app_users(user_id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.auth_presence (
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  session_id uuid not null references public.auth_sessions(id) on delete cascade,
  last_seen_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, session_id)
);

create index if not exists idx_auth_presence_seen
  on public.auth_presence (last_seen_at desc);

create table if not exists public.auth_login_attempts (
  attempt_key_hash text primary key,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  window_started_at timestamptz not null,
  locked_until timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_login_attempts_cleanup
  on public.auth_login_attempts (updated_at);

create table if not exists public.auth_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.app_users(user_id) on delete cascade,
  purpose text not null check (
    purpose in ('passkey_registration', 'passkey_authentication', 'mfa')
  ),
  challenge_hash text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists idx_auth_challenges_expiry
  on public.auth_challenges (expires_at)
  where consumed_at is null;

create table if not exists public.auth_passkeys (
  credential_id text primary key,
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  relying_party_id text not null,
  public_key bytea not null,
  sign_count bigint not null default 0 check (sign_count >= 0),
  aaguid uuid,
  transports text[] not null default '{}'::text[],
  friendly_name text,
  created_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_auth_passkeys_user_active
  on public.auth_passkeys (user_id, created_at desc)
  where revoked_at is null;

create table if not exists public.auth_mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  factor_type text not null check (factor_type in ('totp')),
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'disabled')),
  secret_ciphertext bytea not null,
  encryption_key_id text not null,
  friendly_name text,
  created_at timestamptz not null default timezone('utc', now()),
  verified_at timestamptz,
  last_used_at timestamptz,
  disabled_at timestamptz
);

create index if not exists idx_auth_mfa_factors_user_status
  on public.auth_mfa_factors (user_id, status);

create table if not exists public.auth_recovery_codes (
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  used_at timestamptz,
  primary key (user_id, code_hash)
);

create index if not exists idx_auth_recovery_codes_available
  on public.auth_recovery_codes (user_id, created_at desc)
  where used_at is null;

create table if not exists public.auth_email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(user_id) on delete cascade,
  purpose text not null check (
    purpose in ('email_verification', 'password_reset', 'account_invite')
  ),
  token_hash text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists idx_auth_email_tokens_lookup
  on public.auth_email_tokens (user_id, purpose, expires_at)
  where consumed_at is null;

insert into public.schema_migrations (version, description)
values ('032', 'native authentication tables without account scope changes')
on conflict (version) do nothing;

commit;

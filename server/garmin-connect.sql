begin;

create table if not exists public.trail_garmin_pending (
  owner uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  state_hash text not null unique,
  verifier text not null,
  expires_at timestamptz not null,
  primary key (owner, client_id)
);

create table if not exists public.trail_garmin_connections (
  owner uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  provider_id text not null unique,
  permissions jsonb not null,
  credentials jsonb not null,
  connected_at timestamptz not null,
  primary key (owner, client_id)
);

alter table public.trail_garmin_pending enable row level security;
alter table public.trail_garmin_connections enable row level security;
revoke all on public.trail_garmin_pending, public.trail_garmin_connections from public, anon, authenticated;
grant select, insert, update, delete on public.trail_garmin_pending, public.trail_garmin_connections to service_role;

commit;

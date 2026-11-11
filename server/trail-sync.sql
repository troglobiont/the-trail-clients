begin;

create schema if not exists trail_private;
revoke all on schema trail_private from public, anon, authenticated;

create table if not exists trail_private.sync_accounts (
  owner uuid primary key references auth.users(id) on delete cascade
);

create table if not exists trail_private.sync_state (
  owner uuid primary key references trail_private.sync_accounts(owner) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists trail_private.sync_receipts (
  owner uuid not null references trail_private.sync_state(owner) on delete cascade,
  request_id uuid not null,
  revision bigint not null,
  primary key (owner, request_id)
);

alter table trail_private.sync_accounts enable row level security;
alter table trail_private.sync_state enable row level security;
alter table trail_private.sync_receipts enable row level security;
revoke all on all tables in schema trail_private from public, anon, authenticated;

create or replace function public.trail_sync_read(p_revision bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  current_revision bigint;
  current_data jsonb;
begin
  if uid is null or not exists (select 1 from trail_private.sync_accounts where owner = uid) then
    raise exception 'trail-sync-forbidden' using errcode = '42501';
  end if;
  select revision, data into current_revision, current_data from trail_private.sync_state where owner = uid;
  current_revision := coalesce(current_revision, 0);
  return jsonb_build_object('revision', current_revision, 'data',
    case when p_revision = current_revision then null else coalesce(current_data, '{}') end);
end;
$$;

create or replace function public.trail_sync_write(p_revision bigint, p_request uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  current_revision bigint;
  current_data jsonb;
  acknowledged_revision bigint;
  bucket record;
  entry record;
  collection jsonb;
begin
  if uid is null or not exists (select 1 from trail_private.sync_accounts where owner = uid) then
    raise exception 'trail-sync-forbidden' using errcode = '42501';
  end if;
  if p_request is null or p_revision is null or p_revision < 0 or p_changes is null
      or jsonb_typeof(p_changes) <> 'object' or octet_length(p_changes::text) > 8500000 then
    raise exception 'trail-sync-invalid' using errcode = '22023';
  end if;

  insert into trail_private.sync_state(owner) values (uid) on conflict (owner) do nothing;
  select revision, data into current_revision, current_data from trail_private.sync_state where owner = uid for update;
  select revision into acknowledged_revision from trail_private.sync_receipts where owner = uid and request_id = p_request;
  if found then
    return jsonb_build_object('revision', acknowledged_revision, 'applied', true);
  end if;
  if current_revision <> p_revision then
    return jsonb_build_object('revision', current_revision, 'applied', false);
  end if;

  for bucket in select key, value from jsonb_each(p_changes) loop
    if bucket.key not in ('clients', 'goals', 'tasks', 'records', 'events', 'services', 'operations', 'reminders', 'ledger')
        or jsonb_typeof(bucket.value) <> 'object' then
      raise exception 'trail-sync-invalid-bucket' using errcode = '22023';
    end if;
    collection := coalesce(current_data -> bucket.key, '{}');
    for entry in select key, value from jsonb_each(bucket.value) loop
      if entry.key !~ '^[-a-zA-Z0-9_]{1,180}$' or entry.key in ('__proto__', 'constructor', 'prototype') then
        raise exception 'trail-sync-invalid-id' using errcode = '22023';
      end if;
      if entry.value = 'null'::jsonb then
        collection := collection - entry.key;
      else
        collection := jsonb_set(collection, array[entry.key], entry.value, true);
      end if;
    end loop;
    current_data := jsonb_set(current_data, array[bucket.key], collection, true);
  end loop;
  if octet_length(current_data::text) > 8500000 then
    raise exception 'trail-sync-too-large' using errcode = '22023';
  end if;

  current_revision := current_revision + 1;
  update trail_private.sync_state set data = current_data, revision = current_revision, updated_at = now() where owner = uid;
  insert into trail_private.sync_receipts(owner, request_id, revision) values (uid, p_request, current_revision);
  return jsonb_build_object('revision', current_revision, 'applied', true);
end;
$$;

revoke all on function public.trail_sync_read(bigint) from public, anon, authenticated;
revoke all on function public.trail_sync_write(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.trail_sync_read(bigint) to authenticated;
grant execute on function public.trail_sync_write(bigint, uuid, jsonb) to authenticated;

commit;

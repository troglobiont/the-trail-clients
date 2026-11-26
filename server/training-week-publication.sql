begin;

create table if not exists trail_private.training_week_publications (
  owner uuid not null references trail_private.sync_accounts(owner) on delete cascade,
  client_id text not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  prepared_at timestamptz not null,
  prepared jsonb not null check (jsonb_typeof(prepared) = 'object' and octet_length(prepared::text) <= 131072),
  published_at timestamptz,
  published jsonb,
  primary key (owner, client_id, week_start),
  check ((published is null) = (published_at is null)),
  check (published_at is null or published_at <= prepared_at)
);
alter table trail_private.training_week_publications enable row level security;
revoke all on trail_private.training_week_publications from public, anon, authenticated;

create or replace function public.trail_training_week_read(p_client_id text, p_prepared boolean, p_week_start date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  athlete text;
  ready jsonb;
  visible_week jsonb;
begin
  if uid is null or not exists (select 1 from trail_private.sync_accounts where owner = uid) then
    raise exception 'training-week-forbidden' using errcode = '42501';
  end if;
  select data #>> array['clients', p_client_id, 'athlete', 'trainingPeaksId']
    into athlete from trail_private.sync_state
    where owner = uid and data #>> array['clients', p_client_id, 'role'] = 'Клиент'
      and coalesce(data #>> array['clients', p_client_id, 'mergedInto'], '') = '';
  select published into visible_week from trail_private.training_week_publications
    where owner = uid and client_id = p_client_id and published ->> 'athleteId' = athlete
      and (p_week_start is null or week_start = p_week_start)
    order by (week_start = date_trunc('week', now() at time zone 'Europe/Belgrade')::date) desc, week_start desc limit 1;
  if p_prepared then
    select jsonb_build_object(
      'weekStart', week_start, 'checkedAt', prepared ->> 'checkedAt', 'count', jsonb_array_length(prepared -> 'sessions')
    ) into ready from trail_private.training_week_publications
      where owner = uid and client_id = p_client_id and prepared ->> 'athleteId' = athlete
        and (p_week_start is null or week_start = p_week_start)
        and (published_at is null or prepared_at > published_at)
      order by week_start desc limit 1;
  end if;
  return jsonb_build_object('published', visible_week, 'prepared', ready);
end;
$$;

create or replace function public.trail_training_week_read(p_client_id text, p_prepared boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$
  select public.trail_training_week_read(p_client_id, p_prepared, null::date);
$$;

create or replace function public.trail_training_week_publish(p_client_id text, p_week_start date, p_checked_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  athlete text;
  changed boolean;
begin
  if uid is null or not exists (select 1 from trail_private.sync_accounts where owner = uid) then
    raise exception 'training-week-forbidden' using errcode = '42501';
  end if;
  select data #>> array['clients', p_client_id, 'athlete', 'trainingPeaksId']
    into athlete from trail_private.sync_state
    where owner = uid and data #>> array['clients', p_client_id, 'role'] = 'Клиент'
      and coalesce(data #>> array['clients', p_client_id, 'mergedInto'], '') = '';
  update trail_private.training_week_publications set published = prepared, published_at = prepared_at
    where owner = uid and client_id = p_client_id and week_start = p_week_start
      and prepared_at = p_checked_at and prepared ->> 'athleteId' = athlete
      and (published_at is null or published_at < prepared_at)
    returning true into changed;
  if changed then return true; end if;
  if exists (select 1 from trail_private.training_week_publications
    where owner = uid and client_id = p_client_id and week_start = p_week_start
      and published_at = p_checked_at and published ->> 'athleteId' = athlete) then
    return false;
  end if;
  raise exception 'training-week-stale' using errcode = 'PT409';
end;
$$;

revoke all on function public.trail_training_week_read(text, boolean) from public, anon, authenticated;
revoke all on function public.trail_training_week_read(text, boolean, date) from public, anon, authenticated;
revoke all on function public.trail_training_week_publish(text, date, timestamptz) from public, anon, authenticated;
grant execute on function public.trail_training_week_read(text, boolean) to authenticated;
grant execute on function public.trail_training_week_read(text, boolean, date) to authenticated;
grant execute on function public.trail_training_week_publish(text, date, timestamptz) to authenticated;

commit;

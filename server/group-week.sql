begin;
create table if not exists trail_private.group_weeks (
  owner uuid not null references trail_private.sync_accounts(owner) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  week jsonb not null check (jsonb_typeof(week) = 'object' and octet_length(week::text) <= 131072),
  primary key (owner, week_start),
  check (week->>'weekStart' = week_start::text and week->>'status' = 'approved')
);
alter table trail_private.group_weeks enable row level security;
revoke all on trail_private.group_weeks from public, anon, authenticated;

create or replace function public.trail_group_week_read(p_day date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null or not exists (select 1 from trail_private.sync_accounts where owner = uid) then
    raise exception 'group-week-forbidden' using errcode = '42501';
  end if;
  select week into result from trail_private.group_weeks where owner = uid
    and week_start = p_day - (extract(isodow from p_day)::integer - 1);
  return result;
end;
$$;
revoke all on function public.trail_group_week_read(date) from public, anon, authenticated;
grant execute on function public.trail_group_week_read(date) to authenticated;
commit;

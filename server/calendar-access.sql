-- Calendar access follows the existing private app account allowlist.
begin;
create or replace function public.trail_calendar_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from trail_private.sync_accounts where owner = auth.uid()
  );
$$;
revoke all on function public.trail_calendar_access() from public, anon;
grant execute on function public.trail_calendar_access() to authenticated;
commit;

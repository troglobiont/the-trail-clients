-- Run in SQL Editor after partners-sync.sql. All test writes are rolled back.
begin;
do $test$
declare
 uid uuid;
 legacy jsonb;
 current_view jsonb;
 receipt jsonb;
 before_data jsonb;
begin
 if has_function_privilege('anon','public.trail_sync_read_v2(bigint)','execute')
    or has_function_privilege('anon','public.trail_sync_write_v2(bigint,uuid,jsonb)','execute') then
  raise exception 'Anonymous access to partner sync';
 end if;
 select s.owner,s.data into uid,before_data from trail_private.sync_state s join trail_private.sync_accounts a using(owner) limit 1 for update of s;
 if uid is null then raise exception 'No app account'; end if;
 perform set_config('request.jwt.claim.sub',uid::text,true);
 legacy := public.trail_sync_read(null::bigint);
 current_view := public.trail_sync_read_v2(null::bigint);
 if (legacy->'data') ? 'partners' or (legacy->'data') ? 'partnerTasks' then raise exception 'Legacy reader exposed new collections'; end if;
 if ((current_view->'data') - 'partners' - 'partnerTasks') <> (legacy->'data') then raise exception 'Legacy projection changed existing data'; end if;
 receipt := public.trail_sync_write_v2((current_view->>'revision')::bigint,gen_random_uuid(),'{}'::jsonb);
 if not (receipt->>'applied')::boolean then raise exception 'V2 write failed'; end if;
 receipt := public.trail_sync_write((receipt->>'revision')::bigint,gen_random_uuid(),'{}'::jsonb);
 if not (receipt->>'applied')::boolean then raise exception 'Legacy write failed'; end if;
 if (select data from trail_private.sync_state where owner=uid) <> before_data then raise exception 'A writer changed unrelated data'; end if;
end;
$test$;
rollback;
select 'Legacy and v2 read/write checks passed; test writes rolled back' as result;

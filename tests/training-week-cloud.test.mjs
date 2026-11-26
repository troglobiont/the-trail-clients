import assert from 'node:assert/strict';
import test from 'node:test';
import {createCloudAPI} from '../src/cloud-api.js';

test('published week reads and explicit publication use the signed-in account and exact revision',async()=>{
  const calls=[];
  const api=createCloudAPI({
    url:'https://example.supabase.co',key:'sb_publishable_example',
    request:async options=>{
      calls.push(options);
      return {status:200,data:options.url.endsWith('_publish')?'true':'{"published":null,"prepared":null}'};
    }
  });
  const week={weekStart:'2026-11-23',checkedAt:'2026-11-25T18:40:00Z'};
  await api.trainingWeek('client-test',false,'session');
  await api.trainingWeek('client-test',true,'session');
  await api.trainingWeek('client-test',false,'session','2026-11-30');
  assert.equal(await api.publishTrainingWeek('client-test',week,'session'),true);
  assert.deepEqual(calls.map(call=>[new URL(call.url).pathname,call.headers.Authorization,call.data]),[
    ['/rest/v1/rpc/trail_training_week_read','Bearer session',{p_client_id:'client-test',p_prepared:false}],
    ['/rest/v1/rpc/trail_training_week_read','Bearer session',{p_client_id:'client-test',p_prepared:true}],
    ['/rest/v1/rpc/trail_training_week_read','Bearer session',{p_client_id:'client-test',p_prepared:false,p_week_start:'2026-11-30'}],
    ['/rest/v1/rpc/trail_training_week_publish','Bearer session',{
      p_client_id:'client-test',p_week_start:week.weekStart,p_checked_at:week.checkedAt
    }]
  ]);
});

test('a stale cloud revision reports a refresh action',async()=>{
  const api=createCloudAPI({
    url:'https://example.supabase.co',key:'sb_publishable_example',
    request:async()=>({status:409})
  });
  await assert.rejects(api.publishTrainingWeek('client-test',{
    weekStart:'2026-11-23',checkedAt:'2026-11-25T18:40:00Z'
  },'session'),error=>error.status===409&&error.message.includes('Открой её ещё раз'));
});

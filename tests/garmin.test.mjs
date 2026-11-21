import assert from 'node:assert/strict';
import test from 'node:test';
import {createGarminHandler} from '../server/garmin-edge.js';
import {emptyState,exportState} from '../src/core.js';
import {garminRecovery,garminSnapshot,latestGarminPulse,mergeGarminSnapshot} from '../src/garmin-data.js';
import {recoveryIndex} from '../src/sport-log.js';
import {addDays} from '../src/model-utils.js';

const owner='10000000-0000-4000-8000-000000000001';
const clientId='client-owner-pilot';
const today='2026-11-21',now=Date.parse(today+'T12:00:00Z');
const workout={activityId:1201,activityName:'Лёгкий бег',startTimeLocal:today+' 06:30:01',
  duration:2700,distance:5300,averageHR:141,activityType:{typeKey:'running'}};
const payload=body=>new Request('https://supabase.example/functions/v1/trail-garmin',
  {method:'POST',body:JSON.stringify(body),headers:{Authorization:'Bearer app-test'}});
const series=value=>Object.fromEntries(Array.from({length:29},(_,index)=>[addDays(today,-index),value]));

function service({user=owner,brokenSleep=false}={}){
  const calls=[];
  const value={owner,clientId,apiKey:'fake-garmin-key'};
  const env=key=>({TRAIL_GARMIN_PERSONAL:JSON.stringify(value),SUPABASE_URL:'https://supabase.example',SUPABASE_ANON_KEY:'anon-key'})[key];
  const mock=async (url,request)=>{
    calls.push([url,request]);
    if(url.startsWith('https://supabase.example/'))return Response.json({id:user});
    if(url.includes('personalapitoken')){
      const claims=Buffer.from(JSON.stringify({exp:now/1000+3600})).toString('base64url');
      return new Response('header.'+claims+'.signed');
    }
    if(url.includes('activitylist-service'))return Response.json([workout,workout,{...workout,activityId:1202,startTimeLocal:'2026-11-22 06:00:00'}]);
    if(url.includes('sleep-service'))return brokenSleep?new Response(null,{status:503}):Response.json({sleepSummaries:[
      ...Object.entries(series(432*60)).map(([calendarDate,sleepTimeSeconds])=>({calendarDate,sleepTimeSeconds})),{sleepTimeSeconds:600}
    ]});
    if(url.includes('hrv-service'))return Response.json({data:[{calendarDate:today,lastNightAvg:61}]});
    if(url.includes('dailysummaries'))return Response.json({dailySummaries:Object.entries(series(47)).map(([calendarDate,restingHeartRate])=>({calendarDate,restingHeartRate}))});
    throw Error('Unexpected URL');
  };
  return {handler:createGarminHandler({env,fetch:mock,now:()=>now}),calls};
}

test('Garmin access is restricted to the owning login and linked athlete',async()=>{
  const {handler,calls}=service({user:'other-user'});
  assert.equal((await handler(payload({clientId}))).status,403);
  assert.equal((await handler(new Request('https://supabase.example',{method:'POST'}))).status,401);
  assert(calls.every(([url])=>url.startsWith('https://supabase.example/')));
  const valid=service();
  assert.equal((await valid.handler(payload({clientId:'different-card'}))).status,403);
  assert.equal(valid.calls.length,1);
});

test('Garmin fetches completed activities, personal rest and sleep and feeds recovery',async()=>{
  const {handler,calls}=service();
  const response=await handler(payload({clientId}));
  assert.equal(response.status,200);
  const next=garminSnapshot(await response.json(),clientId),snapshot=mergeGarminSnapshot(null,next);
  assert.equal(next.activities.length,1);
  assert.equal(next.activities[0].seconds,2700);
  assert.equal(next.activities[0].time,'06:30');
  assert.equal(next.measures.hrv[today],61);
  assert.deepEqual(latestGarminPulse(snapshot,today),{day:today,value:47});
  assert.deepEqual(Object.keys(next.measures.sleepMinutes).length,29);
  const manual={source:'Oura',sleepHeartRate:52,freshness:7};
  const log=garminRecovery(snapshot,{[today]:manual});
  assert.equal(log[today].source,'Garmin');
  assert.equal(log[today].freshness,7);
  assert.equal(log[today].sleepHeartRate,undefined);
  assert.equal(manual.sleepHeartRate,52);
  assert.equal(recoveryIndex(log,today).value,50);
  await handler(payload({clientId}));
  assert.equal(calls.filter(([url])=>url.includes('personalapitoken')).length,1);
  assert.equal(calls.filter(([url])=>url.includes('activitylist-service')).length,1);
});

test('a partial Garmin update retains saved data for unavailable streams',async()=>{
  const full=service(),partial=service({brokenSleep:true});
  const original=garminSnapshot(await(await full.handler(payload({clientId}))).json(),clientId);
  const result=garminSnapshot(await(await partial.handler(payload({clientId}))).json(),clientId);
  assert.equal(result.measures.sleepMinutes,null);
  const saved=mergeGarminSnapshot(null,original);
  const merged=mergeGarminSnapshot(saved,result);
  assert.equal(merged.measures.sleepMinutes[today],432);
  assert.deepEqual(merged.missing,['Сон']);
  const older={...merged,asOf:'2026-11-21T09:00:00Z'};
  assert.equal(mergeGarminSnapshot(merged,older),merged);
  assert.throws(()=>garminSnapshot({...original,clientId:'other'},clientId));
});

test('activity and wellness cache is kept out of the portable client database backup',()=>{
  const state=emptyState();
  state.settings.garminCache={owner,snapshot:{clientId}};
  const {settings}=JSON.parse(exportState(state)).state;
  assert.equal(settings.garminCache,undefined);
  assert.equal(state.settings.garminCache.snapshot.clientId,clientId);
});

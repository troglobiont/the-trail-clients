import test from 'node:test';
import assert from 'node:assert/strict';
import {createCalendarData} from '../src/calendar-data.js';
import {calendarRange,calendarEvent,createCalendarHandler} from '../server/calendar-edge.js';

const now = ()=>Date.parse('2026-11-19T08:00:00Z');
const event = {id:'one',title:'Персональная · Тестовый клиент · Сергей',start:'2026-11-19T14:00:00+01:00',end:'2026-11-19T15:00:00+01:00'};
const fixture = () => {
  let disk,offline=false,broken=false;
  const requests = [];
  const options = {now,saved:()=>disk,save:async value=>{disk=structuredClone(value);},read:async(from,to)=>{
    requests.push([from,to]);
    if (offline || broken && from.endsWith('-01')) throw Error('offline');
    return {mode:'live',source:'cloud',events:[event]};
  }};
  return {options,requests,offline:()=>{offline=true;},broken:()=>{broken=true;},disk:()=>disk};
};

test('calendar is loaded from cloud and survives app restart with Mac and internet unavailable',async()=>{
  const f=fixture();
  const first=createCalendarData(f.options);
  assert.deepEqual((await first.load()).events,[event]);
  assert.deepEqual(f.requests,[['2026-11-19','2026-12-19'],['2026-11-01','2026-11-20']]);
  f.offline();
  const restarted=createCalendarData(f.options);
  assert.equal(restarted.snapshot().mode,'saved');
  assert.equal(restarted.snapshot().coversToday,true);
  const cached=await restarted.load();
  assert.deepEqual(cached.events,[event]);
  assert.equal(cached.refreshError,'offline');
  assert.equal(cached.asOf,'2026-11-19T08:00:00.000Z');
});

test('a partial failure does not erase the complete saved schedule; a successful empty result replaces it',async()=>{
  const f=fixture(),data=createCalendarData(f.options);
  await data.load();
  f.broken();
  assert.equal((await data.load(true)).mode,'saved');
  assert.deepEqual(f.disk().events,[event]);
  const empty=createCalendarData({...f.options,read:async()=>({mode:'live',events:[]})});
  assert.deepEqual((await empty.load()).events,[]);
  assert.deepEqual(f.disk().events,[]);
});

test('concurrent loads share requests; expired snapshots are explicitly marked and first-load failure is not empty success',async()=>{
  const f=fixture(),data=createCalendarData(f.options);
  await Promise.all([data.load(),data.load(),data.refresh()]);
  assert.equal(f.requests.length,2);
  const later=createCalendarData({...f.options,now:()=>Date.parse('2027-01-01T12:00:00Z')});
  assert.equal(later.snapshot().coversToday,false);
  const first=fixture();first.offline();
  await assert.rejects(createCalendarData(first.options).load(),/offline/u);
});

test('cloud calendar uses Belgrade midnight across daylight-saving changes and rejects invalid ranges',()=>{
  assert.deepEqual(calendarRange({from:'2027-03-28',to:'2027-03-29'}),{timeMin:'2027-03-27T23:00:00.000Z',timeMax:'2027-03-28T22:00:00.000Z'});
  assert.deepEqual(calendarRange({from:'2026-10-25',to:'2026-10-26'}),{timeMin:'2026-10-24T22:00:00.000Z',timeMax:'2026-10-25T23:00:00.000Z'});
  for(const pair of [['2026-02-30','2026-03-01'],['2026-11-19','2026-11-19'],['2026-11-01','2027-01-01']])
    assert.throws(()=>calendarRange({from:pair[0],to:pair[1]}));
});

test('only coach personal trainings are exposed; cancelled, all-day and unrelated events stay private',()=>{
  const raw={id:'g1',summary:event.title,start:{dateTime:event.start},end:{dateTime:event.end},etag:'v1'};
  assert.equal(calendarEvent(raw,'private-calendar').title,event.title);
  assert.equal(calendarEvent({...raw,status:'cancelled'},'c'),null);
  assert.equal(calendarEvent({...raw,summary:'Private appointment'},'c'),null);
  assert.equal(calendarEvent({...raw,start:{date:'2026-11-19'}},'c'),null);
});

test('cloud endpoint rejects anonymous, expired and non-allowlisted users before touching Google credentials',async()=>{
  let accesses=0;
  const handler=createCalendarHandler({env:()=>{accesses++;return 'test';},fetch:async()=>new Response('false'),now});
  const req=auth=>new Request('https://example.test',{method:'POST',headers:auth?{Authorization:auth}:{},body:'{}'});
  assert.equal((await handler(req())).status,401);
  assert.equal(accesses,0);
  assert.equal((await handler(req('Bearer session'))).status,403);
  const expired=createCalendarHandler({env:()=>'',fetch:async()=>new Response('{}',{status:401})});
  assert.equal((await expired(req('Bearer expired'))).status,401);
  assert.equal((await handler(new Request('https://example.test',{method:'GET'}))).status,405);
});

test('cloud endpoint signs a read-only Google assertion, paginates and never needs a Mac',async()=>{
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const pkcs8=Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64');
  const config=JSON.stringify({calendarId:'test-calendar',account:{client_email:'test@example.test',private_key:'-----BEGIN PRIVATE KEY-----\n'+pkcs8+'\n-----END PRIVATE KEY-----'}});
  const calls=[];
  const handler=createCalendarHandler({env:name=>name==='TRAIL_GOOGLE_CALENDAR'?config:'https://cloud.example.test',now,fetch:async(url,options)=>{
    calls.push(url);
    if(url.includes('trail_calendar_access'))return new Response('true');
    if(url==='https://oauth2.googleapis.com/token') {
      const assertion=options.body.get('assertion');
      const claims=JSON.parse(Buffer.from(assertion.split('.')[1],'base64url'));
      assert.equal(claims.scope,'https://www.googleapis.com/auth/calendar.events.readonly');
      assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',keys.publicKey,Buffer.from(assertion.split('.')[2],'base64url'),new TextEncoder().encode(assertion.split('.').slice(0,2).join('.'))),true);
      return Response.json({access_token:'google-token',expires_in:3600});
    }
    assert.ok(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/test-calendar/events?'));
    assert.equal(options.headers.Authorization,'Bearer google-token');
    return Response.json(url.includes('pageToken=next')?{items:[]}:{nextPageToken:'next',items:[{id:'g1',summary:event.title,start:{dateTime:event.start},end:{dateTime:event.end}}]});
  }});
  const req=()=>new Request('https://cloud.example.test',{method:'POST',headers:{Authorization:'Bearer session'},body:JSON.stringify({from:'2026-11-19',to:'2026-11-20'})});
  const response=await handler(req());
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.events.length,1);assert.equal(data.source,'cloud');
  await handler(req());
  assert.equal(calls.filter(url=>url.includes('oauth2')).length,1);
});

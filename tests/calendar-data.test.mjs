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

test('history loads only the chosen calendar month and keeps the saved upcoming schedule intact',async()=>{
  const f=fixture(),old={...event,id:'october',start:'2026-10-31T22:45:00Z',end:'2026-10-31T22:55:00Z'};
  const next={...event,id:'november',start:'2026-10-31T23:15:00Z',end:'2026-10-31T23:30:00Z'};
  const data=createCalendarData({...f.options,read:async(from,to)=>{
    const result=await f.options.read(from,to);
    return from==='2026-10-01'?{...result,events:[old,next]}:result;
  }});
  await data.load();
  assert.deepEqual((await data.loadHistory('2026-11')).events,[event]);
  const [october,parallel]=await Promise.all([data.loadHistory('2026-10'),data.loadHistory('2026-10')]);
  assert.deepEqual(october.events,[old]);
  assert.deepEqual(october,parallel);
  assert.deepEqual(f.requests,[['2026-11-19','2026-12-19'],['2026-11-01','2026-11-20'],['2026-10-01','2026-11-01']]);
  assert.deepEqual(f.disk().events,[event]);
  f.offline();
  assert.equal((await data.loadHistory('2026-10',true)).mode,'saved');
  await assert.rejects(data.loadHistory('2026-09'),/offline/u);
  await assert.rejects(data.loadHistory('2026-12'),/Некорректный месяц/u);
});

test('athlete week reuses the schedule cache and reads both sides of a month boundary',async()=>{
  const f=fixture(), data=createCalendarData(f.options);
  await data.load();
  assert.deepEqual((await data.loadWeek('2026-11-16')).events,[event]);
  assert.equal(f.requests.length,2);
  f.offline();
  const reopened=createCalendarData(f.options);
  assert.equal((await reopened.loadWeek('2026-11-16')).mode,'saved');

  const crossMonth=fixture(), monday={...event,start:'2026-11-30T11:00:00+01:00',end:'2026-11-30T12:00:00+01:00'};
  const december=createCalendarData({...crossMonth.options,now:()=>Date.parse('2026-12-02T08:00:00Z'),
    read:async(from,to)=>({...await crossMonth.options.read(from,to),events:[event,monday]})});
  assert.deepEqual((await december.loadWeek('2026-11-30')).events,[monday]);
  assert.deepEqual(crossMonth.requests,[['2026-11-30','2026-12-07']]);
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

test('copy, move and cancel use the club calendar and do not recreate processed meetings',async()=>{
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const pkcs8=Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64');
  const config=JSON.stringify({calendarId:'test-calendar',account:{client_email:'test@example.test',private_key:'-----BEGIN PRIVATE KEY-----\n'+pkcs8+'\n-----END PRIVATE KEY-----'}});
  const group=(id,summary,day,time)=>({id,summary,start:{dateTime:day+'T'+time+':00+01:00'},
    end:{dateTime:day+'T'+time+':00+00:00'},location:'Парк',etag:'tag-'+id});
  const source=group('source-a','Группа · Парк · Сергей','2027-03-27','17:30');
  const blocked=group('source-b','Группа · Парк · Сергей','2027-03-26','17:30');
  const existing=group('manual','Группа · Парк · Алексей','2027-04-02','16:30');
  const rows=new Map([[source.id,source],[blocked.id,blocked],[existing.id,existing]]);
  const log=[];
  const handler=createCalendarHandler({env:name=>name==='TRAIL_GOOGLE_CALENDAR'?config:'https://cloud.example.test',
    now:()=>Date.parse('2027-03-27T20:00:00Z'),fetch:async(address,options)=>{
      const url=new URL(address),{method,headers}=options;
      if(url.pathname.endsWith('/trail_calendar_access'))return new Response('true');
      if(url.hostname==='oauth2.googleapis.com'){
        const claim=JSON.parse(Buffer.from(options.body.get('assertion').split('.')[1],'base64url'));
        return Response.json({access_token:claim.scope.endsWith('.readonly')?'reader':'writer',expires_in:3600});
      }
      assert.ok(url.pathname.startsWith('/calendar/v3/calendars/test-calendar/events'));
      if(url.searchParams.get('fields')==='accessRole')return Response.json({accessRole:'writer'});
      const id=url.pathname.split('/events/')[1];
      if(method==='GET'&&!id){
        const from=Date.parse(url.searchParams.get('timeMin')),to=Date.parse(url.searchParams.get('timeMax'));
        return Response.json({items:[...rows.values()].filter(r=>r.status!=='cancelled'&&Date.parse(r.start.dateTime)>=from&&Date.parse(r.start.dateTime)<to)});
      }
      if(method==='GET')return rows.has(id)?Response.json(rows.get(id)):new Response('{}',{status:404});
      assert.equal(headers.Authorization,'Bearer writer');
      assert.equal(url.searchParams.get('sendUpdates'),'none');
      const body=options.body&&JSON.parse(options.body);
      log.push([method,id??body.id]);
      if(method==='POST'){
        if(rows.has(body.id))return new Response('{}',{status:409});
        assert.equal(body.attendees,undefined);
        rows.set(body.id,{...body,etag:'created'});
        return Response.json({id:body.id});
      }
      assert.equal(headers['If-Match'],rows.get(id).etag);
      if(method==='PATCH'){
        const next={...rows.get(id),...body,etag:'changed'};rows.set(id,next);return Response.json(next);
      }
      rows.set(id,{id,status:'cancelled'});
      return new Response(null,{status:204});
    }});
  const send=body=>handler(new Request('https://cloud.example.test',{method:'POST',headers:{Authorization:'Bearer session'},body:JSON.stringify(body)}));
  const copy={action:'copy-group-week',from:'2027-03-29',coaches:[{id:source.id,coachName:'Алексей Тестов',status:'draft'}]};
  assert.deepEqual(await (await send(copy)).json(),{created:1,skipped:1,failed:0,sourceCount:2});
  const id=log[0][1],newEvent=rows.get(id);
  assert.deepEqual([newEvent.start.dateTime,newEvent.end.dateTime],['2027-04-03T15:30:00.000Z','2027-04-03T16:30:00.000Z']);
  assert.equal(newEvent.summary,'Группа · Парк · Алексей Тестов');
  assert.equal(newEvent.colorId,'6');
  assert.match(newEvent.description,/Статус назначения: предварительное/u);
  assert.equal(newEvent.extendedProperties.private.trailRosterCoach,'Сергей');
  const expected={start:newEvent.start.dateTime,end:newEvent.end.dateTime,location:newEvent.location};
  const edit={action:'move-group',id,expected,day:'2027-04-03',time:'18:00'};
  assert.equal((await send({...edit,expected:{...expected,location:'Изменённое место'}})).status,409);
  const {event:moved}=await (await send(edit)).json();
  assert.equal(moved.start,'2027-04-03T16:00:00.000Z');
  assert.equal(moved.id,id);
  assert.equal(moved.rosterCoachName,'Сергей');
  const reassign={action:'assign-group',id,coachName:'Сергей',status:'approved',
    expected:{start:moved.start,end:moved.end,location:moved.location,coachName:moved.coachName}};
  const {event:assigned}=await (await send(reassign)).json();
  assert.equal(assigned.coachName,'Сергей');
  assert.equal(assigned.colorId,'10');
  assert.equal(assigned.assignmentStatus,'approved');
  assert.equal(assigned.start,moved.start);
  assert.equal(assigned.copiedWeek,copy.from);
  const revised={action:'edit-group',id,expected:{...expected,start:assigned.start,end:assigned.end,coachName:assigned.coachName},
    day:'2027-04-03',time:'18:00',location:'Стадион',coachName:'Алексей Тестов',status:'draft'};
  const previousWrites=log.length;
  const {event:changed}=await (await send(revised)).json();
  assert.equal(log.length,previousWrites+1);
  assert.equal(changed.start,assigned.start);
  assert.equal(changed.location,'Стадион');
  assert.equal(changed.title,'Группа · Стадион · Алексей Тестов');
  assert.equal(changed.assignmentStatus,'draft');
  assert.equal(changed.colorId,'6');
  assert.deepEqual(await (await send(copy)).json(),{created:0,skipped:2,failed:0,sourceCount:2});
  const cancel={action:'cancel-group',id,expected:{start:changed.start,end:changed.end,location:changed.location}};
  assert.deepEqual(await (await send(cancel)).json(),{cancelled:true});
  assert.deepEqual(await (await send(copy)).json(),{created:0,skipped:2,failed:0,sourceCount:2});
  assert.equal(rows.get(id).status,'cancelled');
  assert.deepEqual(rows.get(existing.id),existing);
});

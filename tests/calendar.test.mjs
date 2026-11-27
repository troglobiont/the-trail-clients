import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient, emptyState, linkCalendarTask} from '../src/core.js';
import * as A from '../src/accounting.js';
import {localDate} from '../src/model-utils.js';
import {athleteScheduleEntries, athleteScheduleKinds, calendarClient, calendarPlace, cancellationRecipients, isSchedulingTask, matchesScheduleKind, personalWeekMeetings, taskCalendarChoices} from '../src/calendar-ui.js';
import {cancellationText,notifyCancellation} from '../src/schedule-cancellation-ui.js';
import {athletePlanSessions} from '../src/training-calendar-ui.js';
import {calendarEvent} from '../server/calendar-edge.js';
import {OWNER_COACH,previewGroupScheduleVisible} from '../src/role-preview.js';

test('the opt-in calendar feed keeps groups separate from clients and scopes group meetings to the assigned coach',()=>{
  const dateTime='2026-11-26T19:00:00+01:00';
  const raw={id:'group-event',summary:'Группа · Калемегдан · Алексей',start:{dateTime},end:{dateTime:'2026-11-26T20:00:00+01:00'}};
  assert.equal(calendarEvent(raw,'calendar'),null);
  assert.equal(calendarEvent({...raw,status:'cancelled'},'calendar',true),null);
  const event=calendarEvent(raw,'calendar',true);
  assert.equal(event.kind,'group');
  assert.equal(event.location,'Калемегдан');
  const s=emptyState(),coach=createClient(s,{name:'Соболев Алексей',role:'Тренер'});
  assert(previewGroupScheduleVisible(event,s,{role:'superadmin'}));
  assert(previewGroupScheduleVisible(event,s,{role:'coach',coachId:coach.id}));
  assert(!previewGroupScheduleVisible(event,s,{role:'coach',coachId:OWNER_COACH}));
  assert(!previewGroupScheduleVisible(event,s,{role:'athlete'}));
  assert.equal(calendarClient(event,s.clients,coach.id),undefined);
  const personal={...raw,summary:'Персональная · Тестовый клиент · Сергей'};
  assert.deepEqual(calendarEvent(personal,'calendar',true),calendarEvent(personal,'calendar'));
});

test('finding a session by a unique first name does not associate an ambiguous first name', () => {
  const task = {id:'task-1',clientId:'c1',title:'Согласовать день недели и время тренировки'};
  const clients = {c1:{id:'c1',name:'Тестова Эмилия'},c2:{id:'c2',name:'Тестов Иван'}};
  const singleName = {id:'one',title:'Персональная · Эмилия · Сергей'};
  const fullName = {id:'two',title:'Персональная · Эмилия Тестова · Сергей'};
  const foreign = {id:'three',title:fullName.title,clientId:'c2'};
  assert.ok(isSchedulingTask(task));
  assert.deepEqual(taskCalendarChoices([singleName,fullName,foreign],clients,task,{}),[singleName,fullName]);
  clients.c3 = {id:'c3',name:'Примерова Эмилия'};
  assert.deepEqual(taskCalendarChoices([singleName,fullName,foreign],clients,task,{}),[fullName]);
});

test('linking keeps the calendar event on the completed task and rejects another task using it', () => {
  const task = {id:'task-1',clientId:'c1',phase:'todo'}, other = {...task,id:'task-2'};
  const s = {tasks:{[task.id]:task,[other.id]:other},events:[]};
  const event = {id:'google-event',start:'2026-11-19T15:30:00+01:00',end:'2026-11-19T16:30:00+01:00'};
  linkCalendarTask(s,task.id,event);
  assert.equal(task.phase,'done');
  assert.equal(task.calendarEvent.id,event.id);
  assert.throws(()=>linkCalendarTask(s,other.id,event),/уже привязана/u);
  assert.equal(other.phase,'todo');
});

test('the abbreviated title for an outdoor session resolves to the client and outdoor tariff', () => {
  const client = {id:'c1',name:'Тестов Владимир'};
  const event = {title:'Персональная · Владимир · Сергей',location:'Калемегдан'};
  assert.equal(calendarClient(event,{c1:client}),client);
  assert.equal(calendarPlace(event.location),'Улица');
  assert.equal(calendarPlace('Mega Gym'),'Зал');
});

test('schedule filters keep group meetings separate from personal gym and outdoor sessions', () => {
  const group = {kind:'group', location:'Mega Gym'};
  const gym = {location:'Mega Gym'};
  const outdoor = {location:'Калемегдан'};
  const unknown = {location:''};
  const events = [group,gym,outdoor,unknown];
  assert.deepEqual(events.filter(event=>matchesScheduleKind(event,null)),events);
  assert.deepEqual(events.filter(event=>matchesScheduleKind(event,'group')),[group]);
  assert.deepEqual(events.filter(event=>matchesScheduleKind(event,'gym')),[gym]);
});

test('cancellation includes the calendar roster and only an unambiguous personal client',()=>{
  const state=emptyState(), first=createClient(state,{name:'Тестов Иван'}),
    second=createClient(state,{name:'Тестова Мария'}), paused=createClient(state,{name:'Примерова Мария',status:'На паузе'}),
    coach=createClient(state,{name:'Тестов Алексей',role:'Тренер'});
  second.coachId=coach.id;
  for(const client of [first,second,paused]){
    A.saveService(state,{clientId:client.id,kind:'belgrade',block:'belgrade',place:null,currency:'RSD',rate:800000,
      startsOn:'2026-11-01',endsOn:null,day:20,reminder:false});
  }
  const group={id:'group',kind:'group',start:'2026-11-28T18:00:00+01:00',coachName:'Алексей',rosterCoachName:'Сергей'};
  assert.deepEqual(cancellationRecipients(state,group).map(c=>c.id),[first.id]);
  assert.deepEqual(cancellationRecipients(state,{...group,rosterCoachName:'Другой'}),[]);
  const personal={id:'personal',title:'Персональная · Тестова Мария · Сергей'};
  assert.deepEqual(cancellationRecipients(state,personal).map(c=>c.id),[second.id]);
  assert.deepEqual(cancellationRecipients(state,{...personal,clientId:first.id}),[]);
  assert.deepEqual(cancellationRecipients(state,{...personal,title:'Персональная · Иван · Сергей'}),[]);
  assert.deepEqual(cancellationRecipients(state,personal,first.id).map(c=>c.id),[first.id]);
});

test('cancellation retries use the same key and never send to a changed or duplicated recipient',async()=>{
  const event={id:'group',kind:'group',start:'2026-11-28T18:00:00+01:00',location:'Парк'};
  const body=cancellationText(event,'28 нояб.','18:00–19:00','Из-за погоды');
  const binding={peerId:'123',accountPeerId:'456'};
  const clients={a:{id:'a',telegram:binding},b:{id:'b',telegram:binding},c:{id:'c',telegram:{...binding,peerId:'789'}}};
  const calls=[];
  const send=(recipients)=>notifyCancellation({event,body,state:()=>({clients}),
    recipients:recipients.map(client=>({client,binding})),service:async(path,payload)=>{
      if(path==='/telegram/status')return {connected:true,account:{peerId:'456'}};
      calls.push(payload);
      return calls.length===1?{error:'timeout'}:{messageId:'10',sentAt:'2026-11-27T13:00:00Z'};
    }});
  const results=await send(Object.values(clients));
  assert.equal(calls.length,1);
  assert.match(results[0].error,/не подтвердил/u);
  assert.equal(results[1].error,results[0].error);
  assert.match(results[2].error,/изменилась/u);
  assert.equal((await send([clients.a]))[0].error,null);
  assert.deepEqual(calls[0],calls[1]);
  assert.match(calls[0].text,/18:00–19:00 · Парк\nИз-за погоды/u);
});

test('the athlete week requires an unambiguous client and a personal tariff at the venue on that date', () => {
  const s = emptyState(), first = createClient(s,{name:'Тестов Иван'}), second = createClient(s,{name:'Тестова Мария'});
  const day = '2026-11-28';
  for (const [client,place] of [[first,'Зал'],[second,'Улица']]) {
    A.saveService(s,{clientId:client.id,kind:'personal',block:'personal',place,currency:'RSD',rate:400000,
      startsOn:'2026-11-01',endsOn:null,day:null,reminder:false});
  }
  const meeting=(id,name,location,date=day)=>({id,title:'Персональная · '+name+' · Сергей',location,
    start:date+'T11:45:00+01:00',end:date+'T12:45:00+01:00'});
  const gym=meeting('gym','Иван Тестов','Mega Gym'), outdoor=meeting('outdoor','Тестова Мария','Парк «Галерея»');
  const linked=meeting('linked','Иван','Mega Gym'), conflict={...meeting('conflict','Иван','Mega Gym'),clientId:second.id};
  s.tasks={one:{clientId:first.id,calendarEvent:{id:linked.id}},two:{clientId:first.id,calendarEvent:{id:conflict.id}}};
  const events=[gym,gym,outdoor,linked,conflict,meeting('only-first-name','Иван','Mega Gym'),
    meeting('wrong-place','Тестов Иван','Калемегдан'),meeting('before-tariff','Тестов Иван','Mega Gym','2026-10-31'),
    {...meeting('conflicting-name','Тестова Мария','Mega Gym'),clientId:first.id},
    {...gym,id:'group',kind:'group'}];
  assert.deepEqual(personalWeekMeetings(s,first.id,events).map(item=>item.event.id),['gym','linked']);
  assert.deepEqual(personalWeekMeetings(s,second.id,events).map(item=>item.event.id),['outdoor']);
  second.aliases=['Иван Тестов'];
  assert.deepEqual(personalWeekMeetings(s,first.id,events).map(item=>item.event.id),['linked']);
});

test('the athlete schedule and plan classify only the group covered by the tariff', () => {
  const state=emptyState(), athlete=createClient(state,{name:'Тестов Иван'}),
    outdoor=createClient(state,{name:'Тестова Мария'}), coach=createClient(state,{name:'Тестов Алексей',role:'Тренер'});
  const base={startsOn:'2026-11-01',endsOn:null,currency:'RSD',rate:400000,reminder:false};
  A.saveService(state,{...base,clientId:athlete.id,kind:'belgrade',block:'belgrade',day:20,place:null,
    pauses:[{from:'2026-11-29',until:null}]});
  A.saveService(state,{...base,clientId:athlete.id,kind:'personal',block:'personal',day:null,place:'Зал'});
  A.saveService(state,{...base,clientId:outdoor.id,kind:'personal',block:'personal',day:null,place:'Улица'});
  const saturday='2026-11-28',sunday='2026-11-29';
  const meeting=(id,coachName,day)=>({id,kind:'group',coachName,location:'Калемегдан',title:'Группа',start:day+'T09:00:00+01:00'});
  const events=[meeting('ours','Сергей',saturday),meeting('other','Алексей',saturday),meeting('paused','Сергей',sunday)];
  assert.deepEqual(athleteScheduleKinds(state,athlete.id,saturday),['group','gym']);
  assert.deepEqual(athleteScheduleKinds(state,outdoor.id,saturday),['outside']);
  assert.deepEqual(athleteScheduleEntries(state,athlete.id,events).map(({event})=>event.id),['ours']);
  assert.deepEqual(athleteScheduleEntries(state,outdoor.id,events),[]);
  athlete.coachId=coach.id;
  assert.deepEqual(athleteScheduleEntries(state,athlete.id,events).map(({event})=>event.id),['other']);
  const plan=[{day:saturday,title:'Бег'},{day:saturday,title:'ОФП'},{day:saturday,title:'Индивидуальный план'},{day:sunday,title:'Бег'}];
  const group={sessions:plan.filter(session=>session.title!=='Индивидуальный план')};
  assert.deepEqual(athletePlanSessions(state,athlete.id,plan,group).map(slot=>slot.kind||null),['group','group',null,null]);
});

test('completing a calendar session uses advance once and can record a separate actual payment', () => {
  const s = emptyState();
  const date = localDate();
  const client = createClient(s,{name:'Тестов Владимир'},date);
  const service = A.saveService(s,{clientId:client.id,kind:'personal',block:'personal',place:'Улица',currency:'RSD',rate:400000,
    startsOn:date,endsOn:null,day:null,reminder:false,openingCredit:{date,amount:3200000}});
  const data = {clientId:client.id,serviceId:service.id,place:service.place,amount:service.rate,currency:service.currency,date,
    sessionId:'calendar-session-one',paymentId:'calendar-payment-one'};
  A.recordCalendarSession(s,data);
  assert.deepEqual(A.serviceBalance(s,service.id),{received:0,used:400000,balance:2800000});
  assert.throws(()=>A.recordCalendarSession(s,data),/уже записана/u);
  assert.equal(A.operations(s).length,1);
  const sameDay = {...data,sessionId:'calendar-session-two',paymentId:'calendar-payment-two',received:400000,receivedOn:date};
  const [session,receipt] = A.recordCalendarSession(s,sameDay);
  assert.equal(receipt.sessionId,session.id);
  assert.equal(A.serviceBalance(s,service.id).balance,2800000);
  A.setVoided(s,session.id,true);
  assert.throws(()=>A.recordCalendarSession(s,sameDay),/уже есть оплата/u);
});

test('taking money first preserves a separate session and prevents a duplicate receipt', () => {
  const s = emptyState(), date = localDate();
  const client = createClient(s,{name:'Тестовый клиент'},date);
  const service = A.saveService(s,{clientId:client.id,kind:'personal',block:'personal',place:'Улица',currency:'RSD',rate:400000,
    startsOn:date,endsOn:null,day:null,reminder:false});
  const entry = {clientId:client.id,serviceId:service.id,place:service.place,amount:service.rate,currency:service.currency,date,
    sessionId:'calendar-session-one',paymentId:'calendar-payment-one'};
  A.recordCalendarSession(s,{...entry,performed:false,received:400000,receivedOn:date});
  assert.deepEqual(A.operations(s).map(item=>item.kind),['payment']);
  assert.throws(()=>A.recordCalendarSession(s,{...entry,received:400000,receivedOn:date}),/уже есть оплата/u);
  A.recordCalendarSession(s,entry);
  assert.deepEqual(A.serviceBalance(s,service.id),{received:400000,used:400000,balance:0});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,emptyState,mergeState,validateState} from '../src/core.js';
import {accounting,clientAccountHistory,saveService} from '../src/accounting.js';
import {GROUP_REPORT,groupCompletion,groupEventReference,saveGroupCompletion,submitCoachCash,reviewCoachCash,coachCash} from '../src/coach-accounting.js';
import {groupCoach,OWNER_COACH} from '../src/role-preview.js';
import {saveTeamGroupRate,teamEntries,teamSummary} from '../src/team.js';
import {beginCloudSync,cloudData,prepareCloudWrite,receiveCloudData,trackCloudChanges} from '../src/cloud-state.js';

const day='2026-11-24';
const now=new Date(day+'T18:00:00Z');
const later=new Date(day+'T19:00:00Z');
const group={id:'instance-a',url:'https://calendar.google.com/calendar/event?eid=instance-calendar-a',
  kind:'group',start:day+'T16:00:00+01:00',end:day+'T17:15:00+01:00',location:'Парк'};
const admin={role:'superadmin'};
function fixture(){
  const state=emptyState();
  const trainer=createClient(state,{name:'Тестов Алексей',role:'Тренер'},day);
  const other=createClient(state,{name:'Тестов Олег',role:'Тренер'},day);
  const client=createClient(state,{name:'Тестовый спортсмен'},day);
  const service=saveService(state,{clientId:client.id,kind:'belgrade',block:'belgrade',startsOn:day,endsOn:null,day:24,
    rate:800000,currency:'RSD',reminder:true,place:null});
  const coach={role:'coach',coachId:trainer.id};
  return {state,trainer,other,client,service,coach};
}
const cash=service=>({serviceId:service.id,date:day,period:'2026-11',currency:'RSD',amount:800000,note:'Получено на тренировке'});

test('one group session earns one accrual, and only an admin can correct completed attribution',()=>{
  const {state,trainer,other,coach}=fixture();
  const id='group-instance';
  assert.equal(groupEventReference(group),'instance-calendar-a');
  assert.throws(()=>saveGroupCompletion(state,id,group,other.id,coach,false,now),/суперадмин/u);
  assert.throws(()=>saveGroupCompletion(state,id,group,trainer.id,coach,false,new Date(group.start)),/после занятия/u);
  const entry=saveGroupCompletion(state,id,group,trainer.id,coach,false,now);
  saveTeamGroupRate(state,trainer.id,250000);
  assert.equal(saveGroupCompletion(state,id,group,trainer.id,coach,false,later),entry);
  assert.deepEqual(teamSummary(state,trainer.id,'2026-11').currencies.RSD,{accrued:200000,paid:0,expenses:0,balance:200000});
  assert.equal(teamEntries(state,trainer.id,'2026-11')[0].minutes,75);
  assert.throws(()=>saveGroupCompletion(state,id,group,trainer.id,coach,true,later),/суперадмин/u);
  saveTeamGroupRate(state,other.id,300000);
  saveGroupCompletion(state,id,group,other.id,admin,false,later);
  assert.equal(teamEntries(state,trainer.id).length,0);
  assert.equal(teamEntries(state,other.id)[0].amount,300000);
  saveGroupCompletion(state,id,group,other.id,admin,true,later);
  assert.equal(teamEntries(state,other.id).length,0);
  assert.equal(Object.keys(accounting(state).operations).length,0);
  validateState(state);
});

test('cash is pending outside client history until admin approval and can be returned, corrected and retried',()=>{
  const {state,trainer,other,client,service,coach}=fixture();
  const draft=cash(service);
  const pending=submitCoachCash(state,'coach-cash-1',draft,coach,now);
  assert.equal(submitCoachCash(state,pending.id,draft,coach,later),pending);
  assert.deepEqual(coachCash(state,other.id),[]);
  assert.deepEqual(clientAccountHistory(state,client.id),[]);
  assert.throws(()=>reviewCoachCash(state,pending.id,pending.updatedAt,'approved',draft,coach,later),/суперадмин/u);
  const returned=reviewCoachCash(state,pending.id,pending.updatedAt,'returned',{reason:'Уточни валюту'},admin,later);
  assert.equal(returned.status,'returned');
  assert.deepEqual(clientAccountHistory(state,client.id),[]);
  assert.throws(()=>submitCoachCash(state,pending.id,{...draft,expectedUpdatedAt:returned.updatedAt},{role:'coach',coachId:other.id},later),/получивший/u);
  const resubmitted=submitCoachCash(state,pending.id,{...draft,expectedUpdatedAt:returned.updatedAt},coach,new Date(day+'T19:10:00Z'));
  assert.throws(()=>reviewCoachCash(state,pending.id,pending.updatedAt,'approved',draft,admin,later),/изменилась/u);
  assert.throws(()=>reviewCoachCash(state,pending.id,resubmitted.updatedAt,'approved',{...draft,currency:'EUR',amount:8000},admin,later),/зачёт/u);
  const approved=reviewCoachCash(state,pending.id,resubmitted.updatedAt,'approved',
    {...draft,currency:'EUR',amount:8000,credit:800000,note:'x'.repeat(900)},admin,new Date(day+'T20:00:00Z'));
  assert.equal(reviewCoachCash(state,pending.id,resubmitted.updatedAt,'approved',draft,admin,later),approved);
  assert.equal(approved.clientId,trainer.id);
  assert.deepEqual(approved.history.map(e=>e.action),['submitted','returned','resubmitted','approved']);
  assert.equal(clientAccountHistory(state,client.id).length,1);
  assert.equal(accounting(state).operations[approved.operationId].allocations[0].credit,800000);
  assert.equal(accounting(state).operations[approved.operationId].currency,'EUR');
  validateState(state);
});

test('approval syncs with the receipt and survives merging an older pending backup',()=>{
  const {state,service,coach}=fixture();
  const pending=submitCoachCash(state,'coach-cash-2',cash(service),coach,now);
  beginCloudSync(state,'10000000-0000-4000-8000-000000000001');
  receiveCloudData(state,{revision:1,data:cloudData(state)});
  const backup=structuredClone(state);
  reviewCoachCash(state,pending.id,pending.updatedAt,'approved',cash(service),admin,later);
  trackCloudChanges(backup,state);
  const write=prepareCloudWrite(state);
  assert.equal(write.changes.events[pending.id].status,'approved');
  assert.ok(write.changes.operations['payment-'+pending.id]);
  assert.equal(coachCash(mergeState(backup,state))[0].status,'approved');
  assert.equal(coachCash(mergeState(state,backup))[0].status,'approved');
});

test('calendar attribution uses a unique name and prefers an exact full name',()=>{
  const {state,trainer}=fixture();
  assert.equal(groupCoach({coachName:'Алексей'},state),trainer.id);
  createClient(state,{name:'Другой Алексей',role:'Тренер'},day);
  const anotherSergei=createClient(state,{name:'Другой Сергей',role:'Тренер'},day);
  assert.equal(groupCoach({coachName:'Алексей'},state),null);
  assert.equal(groupCoach({coachName:'Сергей'},state),null);
  assert.equal(groupCoach({coachName:'Алексей Тестов'},state),trainer.id);
  assert.equal(groupCoach({coachName:'Сергей Шелковой'},state),OWNER_COACH);
  assert.equal(groupCoach({coachName:'Другой Сергей'},state),anotherSergei.id);
});

test('group reports retain dates without inventing duration or affecting the live balance',()=>{
  const {state,trainer,coach}=fixture();
  const calendarRef=groupEventReference(group);
  const live=saveGroupCompletion(state,'calendar-group',group,trainer.id,coach,false,now);
  const linked={...live,id:'report-linked',type:GROUP_REPORT,source:'Архивный отчёт'};
  const dated={...linked,id:'report-dated',calendarRef:null,minutes:null};
  state.events.push(linked,dated);
  validateState(state);
  assert.equal(groupCompletion(state,live.id,calendarRef),linked);
  assert.equal(teamEntries(state,trainer.id).length,2);
  assert.deepEqual(teamSummary(state,trainer.id,'2026-11').currencies,{});
  assert.equal(teamSummary(state,trainer.id,'2026-11').minutes,75);
  assert.equal(saveGroupCompletion(state,live.id,group,trainer.id,coach,false,later),linked);
  saveGroupCompletion(state,live.id,group,trainer.id,admin,true,later);
  assert.equal(teamEntries(state,trainer.id).length,1);
  assert.deepEqual(teamSummary(state,trainer.id,'2026-11').currencies,{});
  validateState(state);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient,emptyState,mergeState,validateState} from '../src/core.js';
import {accounting,clientAccountHistory,saveService} from '../src/accounting.js';
import {GROUP_REPORT,groupCancellations,groupCompletion,groupEventReference,groupStaffing,saveGroupCancellation,saveGroupCompletion,submitCoachCash,reviewCoachCash,coachCash,updateGroupStaffing} from '../src/coach-accounting.js';
import {groupCoach,OWNER_COACH} from '../src/role-preview.js';
import {athleteScheduleEntries} from '../src/calendar-ui.js';
import {saveTeamEntry,saveTeamGroupRate,saveTeamProfile,saveTeamVisibility,teamEntries,teamMonthFinance,teamSummary} from '../src/team.js';
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

test('club costs distinguish work, cash payouts and possible payroll overlaps',()=>{
  const {state,trainer,other}=fixture();
  saveGroupCompletion(state,'group-instance',group,trainer.id,admin,false,now);
  saveTeamEntry(state,trainer.id,{kind:'work',day,minutes:30,amount:100000,currency:'RSD'});
  const payout=saveTeamEntry(state,trainer.id,{kind:'payout',day,amount:300000,currency:'RSD'});
  const expense=saveTeamEntry(state,other.id,{kind:'expense',day,amount:12000,currency:'RSD'});
  const finance=teamMonthFinance(state,'2026-11',[{date:'',row:{name:'Алексей',values:{RSD:1200000}}}]);
  assert.deepEqual(finance.trainers.map(({groups,minutes,accrued})=>({groups,minutes,accrued})),
    [{groups:1,minutes:105,accrued:{RSD:300000}}]);
  assert.deepEqual(finance.cash.map(record=>record.teamEntry.id),[expense.id]);
  assert.deepEqual(finance.review.map(record=>record.teamEntry.id),[payout.id]);
  assert.equal(teamMonthFinance(state,'2026-11',[]).cash.length,2);
});

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
  linked.payConfirmed=true;
  assert.deepEqual(teamSummary(state,trainer.id,'2026-11').currencies.RSD,
    {accrued:200000,paid:0,expenses:0,balance:200000});
  assert.equal(teamMonthFinance(state,'2026-11',[]).trainers[0].accrued.RSD,200000);
  dated.payConfirmed=true;
  assert.throws(()=>validateState(state),/Некорректная отметка/);
  delete dated.payConfirmed;
  saveGroupCompletion(state,live.id,group,trainer.id,admin,true,later);
  assert.equal(teamEntries(state,trainer.id).length,1);
  assert.deepEqual(teamSummary(state,trainer.id,'2026-11').currencies,{});
  validateState(state);
});

test('administrator drafts take effect in the schedule and requests still require approval',()=>{
  const {state,trainer,other,client}=fixture();
  client.coachId=trainer.id;
  const occurrence={...group,coachName:'Алексей'};
  const before=new Date(day+'T14:00:00Z');
  const coach={role:'coach',coachId:other.id};
  const edit=(event,values,context,at=before)=>updateGroupStaffing(state,'staffing-1',event,values,context,at);
  const draft=edit(occurrence,{action:'draft',revision:0,coachId:other.id},admin);
  assert.equal(groupCoach(occurrence,state),other.id);
  const request=edit(occurrence,{action:'request',revision:draft.revision,coachId:other.id},coach);
  assert.equal(request.requests[other.id].coachId,other.id);
  assert.equal(groupCoach(occurrence,state),other.id);
  const decision={action:'approve',revision:request.revision,coachId:other.id,requesterId:other.id};
  assert.throws(()=>edit(occurrence,decision,coach),/только суперадмин/u);
  assert.throws(()=>edit(occurrence,{...decision,revision:draft.revision},admin),/изменилось/u);
  const approved=edit(occurrence,decision,admin);
  const moved={...occurrence,id:'updated-calendar-id',start:day+'T16:30:00+01:00'};
  assert.equal(groupStaffing(state,moved),approved);
  assert.equal(groupCoach(moved,state),other.id);
  assert.equal(athleteScheduleEntries(state,client.id,[moved]).length,1);
  assert.equal(teamEntries(state,other.id).length,0);
  assert.throws(()=>edit(moved,{action:'draft',revision:approved.revision,coachId:trainer.id},admin,now),/началась/u);
  saveGroupCompletion(state,'recorded-occurrence',moved,other.id,coach,false,now);
  assert.equal(teamEntries(state,other.id).length,1);
  validateState(state);
  const imported=emptyState();
  beginCloudSync(imported,'10000000-0000-4000-8000-000000000001');
  receiveCloudData(imported,{revision:1,data:cloudData(state)});
  assert.equal(groupCoach(moved,imported),other.id);
});

test('group cancellations preserve the note and can be retried without duplicating the event',()=>{
  const {state,trainer,coach}=fixture();
  const before=new Date(day+'T14:00:00Z');
  const edit={action:'draft',revision:0,coachId:trainer.id};
  updateGroupStaffing(state,'staffing-1',group,edit,admin,before);
  assert.throws(()=>saveGroupCancellation(state,'staffing-1',group,'Дождь',coach,before),/суперадмин/u);
  const cancelled=saveGroupCancellation(state,'staffing-1',group,' Дождь ',admin,before);
  assert.equal(saveGroupCancellation(state,'staffing-1',group,'Дождь',admin,before),cancelled);
  assert.deepEqual(groupCancellations(state,day,day),[{day,start:group.start,location:group.location,comment:'Дождь'}]);
  assert.throws(()=>updateGroupStaffing(state,'staffing-1',group,{...edit,revision:cancelled.revision},admin,before),/отменена/u);
  validateState(state);
});

test('invited coaches keep their team history and calendar identity but cannot receive a new group assignment',()=>{
  const {state,trainer,coach}=fixture();
  const event={...group,coachName:'Алексей'};
  const before=new Date(day+'T14:00:00Z');
  saveGroupCompletion(state,'group-old',event,trainer.id,coach,false,now);
  saveTeamVisibility(state,trainer.id,false);
  saveTeamGroupRate(state,trainer.id,250000);
  saveTeamProfile(state,trainer.id,{participation:'guest',specialty:'  ОФП и пилатес  '});
  assert.equal(trainer.teamAdmin.specialty,'ОФП и пилатес');
  assert.equal(trainer.teamAdmin.visible,false);
  assert.equal(trainer.teamAdmin.groupRate,250000);
  assert.equal(teamEntries(state,trainer.id).length,1);
  assert.equal(groupCoach(event,state),trainer.id);
  assert.throws(()=>updateGroupStaffing(state,'staffing-2',event,{action:'draft',revision:0,coachId:trainer.id},admin,before),/Выбери тренера/u);
  saveTeamProfile(state,trainer.id,{participation:'regular',specialty:''});
  assert.equal(trainer.teamAdmin.specialty,undefined);
  assert.equal(updateGroupStaffing(state,'staffing-2',event,{action:'draft',revision:0,coachId:trainer.id},admin,before).draftCoachId,trainer.id);
  validateState(state);
});

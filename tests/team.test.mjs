import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,createClient,validateState,exportState,parseImport,mergeState} from '../src/core.js';
import {teamMembers,teamRole,teamEntries,teamSummary,saveTeamEntry,saveTeamNotes} from '../src/team.js';
import {beginCloudSync,cloudData,receiveCloudData,trackCloudChanges,prepareCloudWrite} from '../src/cloud-state.js';
const owner='10000000-0000-4000-8000-000000000001';
function fixture(){const state=emptyState(),member=createClient(state,{name:'Тестов Алексей',role:'Тренер'});return {state,member};}
const entry=(state,member,kind,day,amount,currency='RSD',minutes=null)=>saveTeamEntry(state,member.id,{kind,day,amount,currency,minutes,note:'Проверка'});

test('team uses existing people, keeps directory roles and never creates client payment operations',()=>{
  const {state,member}=fixture(),org=createClient(state,{name:'Тестова Анна',role:'Тренер',teamRole:'Организатор'});
  createClient(state,{name:'Клиентов Иван'});
  assert.equal(teamMembers(state).length,2);assert.equal(teamRole(org),'Организатор');assert.equal(teamRole(member),'Тренер');
  entry(state,member,'work','2026-11-19',null,'RSD',90);
  saveTeamNotes(state,member.id,'  Работа с группой  ');
  assert.equal(member.teamAdmin.notes,'Работа с группой');assert.equal(state.accounting,undefined);
  assert.equal(teamSummary(state,member.id,'2026-11').minutes,90);
  assert.equal(teamSummary(state,member.id,'2026-11').unpricedWork,1);
  assert.deepEqual(teamSummary(state,member.id,'2026-11').currencies,{});
  validateState(state);
});

test('monthly work and cash totals preserve currencies, carry unpaid balances, and separate extra costs',()=>{
  const {state,member}=fixture();
  entry(state,member,'accrual','2026-10-31',100000);
  entry(state,member,'work','2026-11-10',200000,'RSD',120);
  entry(state,member,'payout','2026-11-12',150000);
  entry(state,member,'expense','2026-11-13',30000);
  entry(state,member,'payout','2026-11-14',5000,'EUR');
  entry(state,member,'accrual','2026-12-01',900000);
  const totals=teamSummary(state,member.id,'2026-11');
  assert.equal(totals.minutes,120);assert.equal(totals.entries,4);
  assert.deepEqual(totals.currencies.RSD,{accrued:200000,paid:150000,expenses:30000,balance:150000});
  assert.deepEqual(totals.currencies.EUR,{accrued:0,paid:5000,expenses:0,balance:-5000});
  assert.equal(teamEntries(state,member.id,'2026-11').length,4);
  assert.throws(()=>teamSummary(state,member.id,'2026-13'),/месяц/u);
});

test('editing replaces one team entry; invalid financial and duration data do not alter history',()=>{
  const {state,member}=fixture(),work=entry(state,member,'work','2026-11-19',10000,'RSD',60);
  const changed=saveTeamEntry(state,member.id,{...work,day:'2026-11-18',minutes:90,amount:20000,currency:'EUR'});
  assert.equal(teamEntries(state,member.id).length,1);assert.equal(changed.id,work.id);assert.equal(changed.createdAt,work.createdAt);
  for(const patch of [{amount:-1},{amount:0},{amount:1.5},{currency:'BTC'},{day:'2026-02-30'},{minutes:0},{minutes:1500},{kind:'unknown'},{kind:'payout',amount:null}])
    assert.throws(()=>saveTeamEntry(state,member.id,{...changed,...patch}),/Проверь/u);
  assert.throws(()=>saveTeamEntry(state,member.id,{...changed,id:'constructor'}),/не найдена/u);
  assert.equal(teamEntries(state,member.id)[0].amount,20000);
  const invalid=structuredClone(state);invalid.clients[member.id].teamAdmin.entries[work.id].currency='BTC';
  assert.throws(()=>validateState(invalid),/Проверь/u);
  validateState(state);
});

test('team notes and entries survive backup, cloud transfer and normal conflict resolution',()=>{
  const {state,member}=fixture();saveTeamNotes(state,member.id,'Согласовать условия');
  entry(state,member,'payout','2026-11-19',10000);
  assert.deepEqual(parseImport(exportState(state)).clients[member.id].teamAdmin,member.teamAdmin);
  assert.deepEqual(mergeState(emptyState(),state).clients[member.id].teamAdmin,member.teamAdmin);
  beginCloudSync(state,owner);receiveCloudData(state,{revision:1,data:cloudData(state)});
  const before=structuredClone(state),remote=structuredClone(cloudData(state));
  entry(state,member,'work','2026-11-20',null,'RSD',30);trackCloudChanges(before,state);
  assert.deepEqual(Object.keys(prepareCloudWrite(state).changes),['clients']);state.cloudSync.flight=null;
  remote.clients[member.id].teamAdmin.notes='Правка на другом устройстве';
  const conflicts=receiveCloudData(state,{revision:2,data:remote});
  assert.equal(conflicts[0].key,'clients/'+member.id);
  receiveCloudData(state,{revision:2,data:remote},{['clients/'+member.id]:'local'});
  assert.equal(teamEntries(state,member.id).length,2);validateState(state);
});

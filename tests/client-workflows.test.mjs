import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.js';
import * as A from '../src/accounting.js';
import { cloudData } from '../src/cloud-state.js';
import { birthdayReminders, raceCatalog, raceParticipants, telegramReminders } from '../src/client-details.js';

test('temporary online does not remove a client from the in-person list; archive and aliases preserve identity',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Петрова Вера',aliases:['Petrova Vera'],format:'Очно',currentFormat:'Дистанционно'});
  assert.deepEqual(C.filterClients(state,{quick:'Очно',section:'active'}).map(c=>c.id),[c.id]);
  assert.deepEqual(C.filterClients(state,{quick:'Дистанционно',section:'active'}),[]);
  C.editClient(state,c.id,{status:'Завершил'});
  assert.equal(C.filterClients(state,{section:'active'}).length,0);
  assert.equal(C.filterClients(state,{section:'archive'})[0].id,c.id);
  assert.throws(()=>C.createClient(state,{name:'Vera Petrova'}),/уже есть/);
});

test('ToDo contains ordinary tasks, discussions and only one pause follow-up; goal is located only when unambiguous',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Тестовый Клиент'});
  const g=C.addGoal(state,c.id,'Tornic Race · 8 мая','Предложение тренера');
  const discussion=C.createTask(state,c.id,'Предложить Tornic Race как цель',{lane:'discussion'});
  const task=C.createTask(state,c.id,'Проверить план',{due:'2026-11-12'});
  assert.equal(C.taskGoal(state,discussion).id,g.id);
  C.editClient(state,c.id,{status:'На паузе',pause:{contactOn:'2026-11-15'}});
  assert.deepEqual(C.clientTasks(state).map(t=>t.id),[task.id,C.pauseTaskId(c.id),discussion.id]);
  C.completePauseContact(state,c.id);
  assert.equal(C.clientTasks(state).length,2);
  assert.equal(state.events.at(-1).due,'2026-11-15');
});

test('birthday crosses year boundary and opening Telegram does not count as confirmed contact',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Тестовый Клиент'});
  C.saveProfile(state,c.id,{birthday:'01-02',phone:'+381 1234567'});
  C.setTelegramBinding(state,c.id,{peerId:'12345'});
  C.setTelegramCheck(state,c.id,5,'2026-12-10');
  assert.equal(birthdayReminders(state,'2026-12-26')[0].day,'2027-01-02');
  assert.equal(telegramReminders(state,'2026-12-15')[0].day,'2026-12-15');
  C.noteTelegramOpen(state,c.id,'12345','2026-12-15T12:00:00Z');
  assert.equal(telegramReminders(state,'2026-12-16').length,0);
  assert.equal(c.lastContact,null);
  assert.equal(state.events.at(-1).type,'telegram-opened');
});

test('race editions persist through backup and cloud without counting proposals or duplicate goals',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Тестовый Клиент'});
  const race=C.defineRace(state,{name:'Белградский полумарафон',date:'2027-04-01'});
  C.setRaceDistances(state,race.id,['10 км','21 км']);
  assert.equal(C.defineRace(state,{name:'  Белградский  полумарафон ',date:'2027-04-01'}).id,race.id);
  const goal=C.addGoal(state,c.id,'Участвовать','Предложение тренера');
  C.editGoal(state,goal.id,goal.title,goal.status,{type:'race',raceStage:'selected',raceId:race.id,distance:'10 км'});
  assert.equal(raceParticipants(state,race.id).length,0);
  C.editGoal(state,goal.id,goal.title,'Согласовано');
  const other=C.addGoal(state,c.id,'Моя десятка','Согласовано');
  C.editGoal(state,other.id,other.title,other.status,{type:'race',raceStage:'registered',raceId:race.id,distance:'10 км'});
  assert.deepEqual(raceParticipants(state,race.id).map(g=>g.id),[other.id]);
  assert.equal(raceParticipants(state,race.id,'21 км').length,0);
  assert.deepEqual(raceCatalog(C.parseImport(C.exportState(state)))[0].distances,['10 км','21 км']);
  assert.ok(Object.values(cloudData(state).events).some(e=>e.type==='race-defined'));
});

test('unified cash totals exclude duplicates and uncertain rows, while sessions and expenses remain distinct',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Тестовый Клиент'});
  const service=A.saveService(state,{clientId:c.id,kind:'personal',block:'personal',place:'Зал',currency:'RSD',rate:400000,
    startsOn:'2026-10-01',endsOn:null,day:null,note:'',reminder:false});
  A.saveOperation(state,{kind:'payment',date:'2026-10-12',amount:400000,currency:'RSD',note:'',payer:'',
    allocations:[{serviceId:service.id,month:null,part:400000,credit:400000}]});
  const entry={month:'2026-10',date:'2026-10-12',kind:'payment',owners:[c.id],block:'personal',values:{RSD:400000}};
  state.ledger={rows:[entry,{...entry,kind:'repeat'},{...entry,kind:'review'},{...entry,kind:'session',detail:'1 зан. × 4000 RSD'},
    {...entry,kind:'expense',values:{RSD:100000}},{...entry,date:'2026-10-17',block:'online',values:{EUR:8000}}]};
  const summary=A.combinedSummary(state,'2026-10');
  assert.deepEqual(summary.receipts,{RSD:400000,EUR:8000});
  assert.deepEqual(summary.expenses,{RSD:100000});
  assert.deepEqual(summary.localBalance,{RSD:300000});
  assert.deepEqual(summary.sessions,{RSD:400000});
  assert.equal(summary.services['unclassified-online'].EUR,8000);
  assert.equal(summary.count,1);
  assert.equal(summary.imported.skippedDuplicates,1);
});

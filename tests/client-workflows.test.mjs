import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.js';
import * as A from '../src/accounting.js';
import { cloudData } from '../src/cloud-state.js';
import { birthdayGreeting, birthdayReminders, raceCatalog, raceCategory, raceParticipants, telegramReminders } from '../src/client-details.js';

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

test('birthday greeting uses the Telegram handle and completing it dismisses only this occurrence',()=>{
  const state=C.emptyState();
  const client=C.createClient(state,{name:'Тестова Вера',telegramHint:'@example_coach_test'});
  C.saveProfile(state,client.id,{birthday:'11-16'});
  assert.match(birthdayGreeting(client),/^@example_coach_test\nВера, с днём рождения!/);
  C.setTelegramBinding(state,client.id,{peerId:'12345',username:'example_linked_test'});
  assert.match(birthdayGreeting(client),/^@example_linked_test\n/);
  assert.equal(birthdayReminders(state,'2026-11-14').length,1);
  C.completeBirthday(state,client.id,'2026-11-16');
  C.completeBirthday(state,client.id,'2026-11-16');
  const restored=C.parseImport(C.exportState(state));
  assert.equal(restored.events.filter(e=>e.type==='birthday-greeted').length,1);
  assert.equal(birthdayReminders(restored,'2026-11-14',90).length,0);
  assert.equal(birthdayReminders(restored,'2027-11-14').length,1);
});

test('new client contacts require a valid birthday without a year and preserve optional fields',()=>{
  const state=C.emptyState();
  const profile={phone:'+381 64 123 4567',secondPhone:'+',email:'coach@example.test',
    city:'Beograd',profession:'Инженер',birthday:'02-29'};
  for(const [field,value,error] of [
    ['phone','+',/основной местный телефон/],
    ['secondPhone','+381',/дополнительный телефон/],
    ['email','',/email/],
    ['city',' ',/основной город/],
    ['profession',' ',/профессию/],
    ['birthday','',/день и месяц/],
    ['birthday','2025-02-29',/дату рождения/]
  ]){
    assert.throws(()=>C.createClient(state,{name:'Тестовый Клиент',profile:{...profile,[field]:value}}),error);
  }
  assert.deepEqual(state.clients,{});
  assert.deepEqual(state.events,[]);
  const client=C.createClient(state,{name:'Тестовый Клиент',profile});
  const {secondPhone,...expected}=profile;
  assert.deepEqual(client.profile,{...expected,city:'Белград'});
  C.saveProfile(state,client.id,{...profile,city:' БЕОГРАД '},{required:true});
  assert.equal(client.profile.city,'Белград');
  C.saveProfile(state,client.id,{...profile,city:'  BELGRADE ',secondPhone:'+7 999 123 4567',birthday:'2000-02-29'},{required:true});
  assert.equal(client.profile.city,'Белград');
  assert.equal(client.profile.secondPhone,'+7 999 123 4567');
  assert.equal(client.profile.birthday,'2000-02-29');
});

test('training journal keeps notes and their tasks linked through edits, cloud and backup',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Тестовый Клиент'});
  const note={day:'2026-11-10',title:'Пороговый тест',text:'Рабочая оценка 182',journalStatus:'candidate'};
  const entry=C.saveJournalEntry(state,c.id,note);
  const task=C.createTask(state,c.id,'Сверить пульсовые зоны',{sourceRecordId:entry.id});
  C.saveJournalEntry(state,c.id,{...note,journalStatus:'review'},entry.id);
  assert.throws(()=>C.saveJournalEntry(state,c.id,{...note,journalStatus:'unknown'},entry.id),/статус/);
  const restored=C.parseImport(C.exportState(state));
  assert.equal(restored.records[entry.id].journalStatus,'review');
  assert.equal(cloudData(restored).records[entry.id].text,note.text);
  assert.equal(C.openTasks(restored)[0].sourceRecordId,entry.id);
  assert.equal(restored.tasks[task.id].due,null);
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

test('updated club calendar retains existing goal links and groups Mont-Blanc distances under one edition',()=>{
  const state=C.emptyState();
  const c=C.createClient(state,{name:'Тестовый Клиент'});
  const selected={id:'race-2027-08-27-occ-2027',name:'OCC 2027',date:'2027-08-27'};
  const goal=C.addGoal(state,c.id,'Бежать OCC','Согласовано');
  state.events.push({type:'race-defined',race:selected});
  Object.assign(goal,{type:'race',raceStage:'selected',raceId:selected.id,distance:'55 км'});
  const calendar=raceCatalog(state,{includeRecommended:true});
  const montBlanc=calendar.find(r=>r.id==='race-club-2027-utmb-mont-blanc');
  assert.ok(montBlanc.aliases.includes(selected.id));
  assert.equal(raceParticipants(state,montBlanc)[0].id,goal.id);
  assert.equal(montBlanc.recommended,false);
  assert.deepEqual(raceCategory(montBlanc),{region:'abroad',discipline:'Трейл',significant:true});
  const avala=calendar.find(r=>r.name==='Avala Trail');
  C.setRaceDistances(state,avala.id,['20 км']);
  assert.deepEqual(raceCatalog(state,{includeRecommended:true}).find(r=>r.id===avala.id).distances,['7,5 км','12 км','18 км','20 км']);
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

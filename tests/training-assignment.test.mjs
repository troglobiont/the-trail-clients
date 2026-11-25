import assert from 'node:assert/strict';
import test from 'node:test';
import {cloudData} from '../src/cloud-state.js';
import {createClient,emptyState} from '../src/core.js';
import {OWNER_COACH,previewRoute,previewTrainingVisible} from '../src/role-preview.js';
import {createStore} from '../src/store.js';
import {applyTrainingAssignment,parseTrainingAssignment,trainingAssignmentFor} from '../src/training-assignment.js';

const monday='2026-11-23';
const source=(trainingPeaksId)=>({schemaVersion:1,trainingPeaksId,sources:{},entries:{},current:{},
  restrictions:{status:'unknown',text:null,day:null}});
const workout={id:'991',day:'2026-11-24',title:'Лёгкий бег',description:'Разминка\r\n\r\nЛёгкий бег.'};
const packet={format:'the-trail-athlete-training-week',schemaVersion:1,athleteId:'131',weekStart:monday,
  checkedAt:'2026-11-25T15:30:00Z',sessions:[workout,{id:'992',day:workout.day,title:'ОФП'}]};

function fixture(state){
  const coach=createClient(state,{name:'Проверка: тренер',role:'Тренер'});
  const rider=createClient(state,{name:'Проверка: спортсмен',coachId:coach.id,athlete:source('131')});
  const other=createClient(state,{name:'Проверка: другой спортсмен',athlete:source('132')});
  return {rider,coach,other};
}

test('personal weeks require a verified athlete, keep two workouts on one day and survive local restart',async()=>{
  let saved;
  const adapter={load:async()=>saved,save:async value=>{saved=value;}};
  const store=await createStore(adapter);
  const {rider,other}=await store.mutate(fixture);
  const parsed=parseTrainingAssignment(JSON.stringify(packet));
  assert.throws(()=>applyTrainingAssignment(store.state(),other.id,parsed),/другому спортсмену/);
  const cloudBefore=cloudData(store.state());
  assert.equal(await store.mutate(state=>applyTrainingAssignment(state,rider.id,parsed)),true);
  assert.deepEqual(cloudData(store.state()),cloudBefore);
  const reopened=(await createStore(adapter)).state();
  const week=trainingAssignmentFor(reopened,rider,monday);
  assert.deepEqual(week.sessions.map(x=>[x.id,x.description]),[['991','Разминка\n\nЛёгкий бег.'],['992','']]);
  assert.equal(trainingAssignmentFor(reopened,other,monday),null);
  assert.equal(trainingAssignmentFor(reopened,{...rider,mergedInto:other.id},monday),null);
});

test('reimport is idempotent, rejects stale changes and replaces the whole week without duplicates',()=>{
  const state=emptyState();
  const {rider}=fixture(state);
  assert(applyTrainingAssignment(state,rider.id,packet));
  assert.equal(applyTrainingAssignment(state,rider.id,packet),false);
  const changed={...packet,sessions:[{...workout,description:'Обновлено'}]};
  assert.throws(()=>applyTrainingAssignment(state,rider.id,changed),/более позднее/);
  assert.equal(trainingAssignmentFor(state,rider,monday).sessions.length,2);
  assert(applyTrainingAssignment(state,rider.id,{...changed,checkedAt:'2026-11-25T16:30:00Z'}));
  assert.deepEqual(trainingAssignmentFor(state,rider,monday).sessions.map(x=>x.description),['Обновлено']);
  assert.throws(()=>parseTrainingAssignment(JSON.stringify({...packet,sessions:[workout,workout]})),/уникальным/);
  assert.throws(()=>parseTrainingAssignment(JSON.stringify({...packet,sessions:[{...workout,day:'2026-11-30'}]})),/границы недели/);
});

test('the personal workout route respects owner, assigned coach and athlete preview scope',()=>{
  const state=emptyState();
  const {rider,coach,other}=fixture(state);
  const athlete={role:'athlete',athleteId:rider.id};
  assert(previewTrainingVisible(state,rider,athlete));
  assert(!previewTrainingVisible(state,other,athlete));
  assert(previewTrainingVisible(state,rider,{role:'coach',coachId:coach.id}));
  assert(!previewTrainingVisible(state,rider,{role:'coach',coachId:OWNER_COACH}));
  assert(previewTrainingVisible(state,rider,{role:'superadmin'}));
  assert(!previewTrainingVisible(state,rider,{role:'accountant'}));
  assert.equal(previewRoute('#calendar',athlete),'#calendar');
  assert.equal(previewRoute('#client/'+other.id+'/training-plan',athlete),'#profile');
});

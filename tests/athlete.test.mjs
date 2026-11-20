import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.js';
import {setTraining} from '../src/client-details.js';
import {applyAthleteImport} from '../src/athlete-import.js';
import {athleteMetric,athleteZones,mergeAthlete,validateAthlete} from '../src/athlete.js';
import {createStore} from '../src/store.js';
import {beginCloudSync,cloudData,receiveCloudData,trackCloudChanges,prepareCloudWrite} from '../src/cloud-state.js';

function fixture(){
  const state=C.emptyState(),client=C.createClient(state,{name:'Тестовый Атлет'}),other=C.createClient(state,{name:'Другой Атлет'});
  C.saveJournalEntry(state,client.id,{day:'2026-11-01',title:'Контрольный тест',text:'TP workout 90001'},'record-test-90001');
  const source={id:'source-a',label:'Тестовый источник',day:'2026-11-02',note:'Обезличенный пример'};
  const entry=(id,kind,status,more={})=>({id,kind,status,title:id,day:'2026-11-01',sourceId:source.id,references:[],details:[],...more});
  const athlete={schemaVersion:1,trainingPeaksId:'90000',sources:{[source.id]:source},entries:{
    test:entry('test','test','field_estimate',{metrics:{lthr:170.4},confidence:'medium'}),
    accepted:entry('accepted','decision','retained',{metric:'lthr',value:170,references:['test'],previousId:null}),
    night:entry('night','observation','observation',{metrics:{sleepMin:48,sleepMax:70}}),
    temporary:entry('temporary','decision','temporary',{metric:'restHr',value:48,references:['night'],previousId:null}),
    platform:entry('platform','snapshot','snapshot',{metrics:{lthr:170,restHr:65,maxHr:195},references:['accepted']}),
    zones:entry('zones','zones','working',{rows:[['Z0',0,149],['Z1',150,159],['Z2',160,169],['Z3',170,175],['Z4',176,189],['Z5',190,255]],lthrRef:'accepted',references:['accepted']})
  },current:{lthr:'accepted',restHr:'temporary',zones:'zones'},goalId:'goal-winter',raceStatus:'Старты обсуждаются',restrictions:{status:'unknown',text:null,day:null}};
  const payload={format:'trail-athlete-import-v1',clientId:client.id,identity:{verifiedBy:'test-review',evidenceRecordId:'record-test-90001',workoutId:'90001'},athlete,
    goal:{id:'goal-winter',title:'Зимняя подготовка',type:'other',status:'Согласовано',sourceRecordId:'source-winter',createdAt:'2026-11-02T12:00:00Z'},
    journal:[{id:'record-test-90001',day:'2026-11-01',title:'Контрольный тест',text:'Другой текст импорта',references:['test','accepted']}]};
  return {state,client,other,payload};
}

test('sport import separates measured results, accepted values and platform snapshots and is idempotent',()=>{
  const {state,client,other,payload}=fixture(),before=structuredClone(other);
  assert.equal(applyAthleteImport(state,client.id,payload).changed,true);
  assert.equal(client.athlete,undefined); // Import commits a validated draft atomically.
  const athlete=state.clients[client.id];
  assert.equal(athlete.athlete.entries.test.metrics.lthr,170.4);
  assert.equal(athleteMetric(athlete,'lthr').value,170);
  assert.equal(athleteMetric(athlete,'restHr').status,'temporary');
  assert.equal(athlete.athlete.entries.platform.metrics.restHr,65);
  assert.equal(athleteZones(athlete).rows[5][2],255);
  assert.deepEqual(athlete.athlete.restrictions,{status:'unknown',text:null,day:null});
  assert.equal(state.records['record-test-90001'].text,'TP workout 90001');
  assert.deepEqual(state.records['record-test-90001'].athleteRefs,['test','accepted']);
  const once=structuredClone(state);assert.equal(applyAthleteImport(state,client.id,payload).changed,false);
  assert.deepEqual(state,once);assert.deepEqual(state.clients[other.id],before);assert.equal(state.accounting,undefined);
});

test('identity mismatch, changed evidence and unsafe references fail without partial writes',()=>{
  const {state,client,payload}=fixture(),before=structuredClone(state);
  for(const change of [p=>p.identity.workoutId='99999',p=>p.clientId='missing',p=>p.athlete.current.lthr='test',
    p=>p.athlete.entries.accepted.status='proposed',p=>p.athlete.entries.test.references=['missing'],p=>p.athlete.entries.zones.rows[3][1]=171]){
    const broken=structuredClone(payload);change(broken);assert.throws(()=>applyAthleteImport(state,client.id,broken));assert.deepEqual(state,before);
  }
  applyAthleteImport(state,client.id,payload);
  const altered=structuredClone(payload);altered.athlete.entries.accepted.value=171;
  assert.throws(()=>applyAthleteImport(state,client.id,altered),/решением|Конфликт/u);
  assert.equal(athleteMetric(state.clients[client.id],'lthr').value,170);
});

test('new accepted versions preserve old evidence; a stale package cannot replace a later decision',()=>{
  const {state,client,payload}=fixture();applyAthleteImport(state,client.id,payload);
  const incoming=structuredClone(payload.athlete);
  incoming.entries.next={...incoming.entries.accepted,id:'next',value:171,previousId:'accepted',references:['accepted','test']};
  incoming.current.lthr='next';
  assert.throws(()=>mergeAthlete(state.clients[client.id],incoming),/изменён/u);
  mergeAthlete(state.clients[client.id],incoming,{expectedCurrent:{lthr:'accepted'}});
  assert.equal(athleteMetric(state.clients[client.id],'lthr').value,171);
  assert.equal(state.clients[client.id].athlete.entries.accepted.value,170);
  assert.throws(()=>applyAthleteImport(state,client.id,payload),/изменён/u);
});

test('training patches preserve unrelated fields and clear only explicitly supplied empty values',()=>{
  const client={training:{height:180,weight:75,lthr:170,date:'2026-10-01',source:'Источник',extension:{retained:true}}};
  setTraining(client,{weight:'76'});
  assert.equal(client.training.height,180);assert.equal(client.training.lthr,170);assert.equal(client.training.source,'Источник');
  setTraining(client,{weight:'',source:''});assert.equal(client.training.weight,undefined);assert.equal(client.training.source,undefined);
  assert.deepEqual(client.training.extension,{retained:true});const before=structuredClone(client);
  assert.throws(()=>setTraining(client,{height:'999'}));assert.deepEqual(client,before);
});

test('sport records persist through disk reload, private backup and cloud with ordinary client conflicts',async()=>{
  const {state,client,payload}=fixture();applyAthleteImport(state,client.id,payload);
  let disk=JSON.stringify(state);const adapter={load:async()=>disk,save:async value=>{disk=value;}};
  const store=await createStore(adapter);await store.mutate(s=>{s.clients[client.id].context='Личная заметка';});
  const reopened=await createStore(adapter),restored=C.parseImport(C.exportState(reopened.state()));
  assert.deepEqual(restored.clients[client.id].athlete,state.clients[client.id].athlete);
  const synced=C.clone(restored);beginCloudSync(synced,'10000000-0000-4000-8000-000000000001');
  receiveCloudData(synced,{revision:1,data:cloudData(synced)});const before=C.clone(synced),remote=C.clone(cloudData(synced));
  synced.clients[client.id].athlete.restrictions={status:'reported',text:'Тестовое ограничение',day:'2026-11-02'};trackCloudChanges(before,synced);
  assert.deepEqual(Object.keys(prepareCloudWrite(synced).changes),['clients']);synced.cloudSync.flight=null;
  remote.clients[client.id].context='Другая правка';assert.equal(receiveCloudData(synced,{revision:2,data:remote}).length,1);
  receiveCloudData(synced,{revision:2,data:remote},{['clients/'+client.id]:'local'});C.validateState(synced);
});

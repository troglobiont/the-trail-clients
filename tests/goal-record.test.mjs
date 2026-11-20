import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.js';
import {goalProposal} from '../src/goal-record.js';
import {raceById} from '../src/client-details.js';
import {bodyMass} from '../src/body-mass.js';

const fixture=()=>{const s=C.emptyState(),c=C.createClient(s,{name:'Тестовый Спортсмен'});return {s,c};};
test('dedicated goal records create independent goals even when an agent requests an old goal update',()=>{
  const {s,c}=fixture(),old=C.addGoal(s,c.id,'Подготовка к сезону','Согласовано'),before=JSON.stringify(old);
  const r=C.saveRecord(s,c.id,'Торник рейс 2027 максимальная дистанция','goal');
  const result=C.applyAgentResult(s,r.id,{changes:[{type:'goal',id:old.id,title:'Подготовка к сезону и новый старт',status:'Согласовано'}]});
  assert.equal(JSON.stringify(s.goals[old.id]),before);
  const goal=s.goals[result.changes[0].id];assert.notEqual(goal.id,old.id);
  assert.equal(goal.type,'race');assert.equal(goal.distance,'33 км');assert.equal(raceById(s,goal.raceId).date,'2027-05-08');
  assert.equal(goal.status,'Желание клиента');assert.equal(goal.raceStage,'selected');
  C.applyAgentResult(s,r.id,{changes:[]});assert.equal(Object.keys(s.goals).length,2);
  const next=C.saveRecord(s,c.id,r.text,'goal');C.processManualRecord(s,next.id);
  assert.equal(Object.keys(s.goals).length,3);assert.equal(JSON.stringify(s.goals[old.id]),before);
});
test('reviewed goal fields override extraction and are saved as the ordinary editable race goal',()=>{
  const {s,c}=fixture(),p=goalProposal(s,'Tornik Race 2027 максимальная дистанция'),r=C.saveRecord(s,c.id,'Tornik Race 2027 максимальная дистанция','goal');
  const result=C.processManualRecord(s,r.id,{goalTitle:'Весенний старт',goalType:'race',goalStatus:'Предложение тренера',raceId:p.raceId,raceStage:'selected',distance:'15 км'});
  const g=s.goals[result.changes[0].id];assert.equal(g.title,'Весенний старт');assert.equal(g.distance,'15 км');assert.equal(g.status,'Предложение тренера');
  C.editGoal(s,g.id,'Тот же старт','Согласовано',{type:g.type,raceId:g.raceId,raceStage:'registered',distance:'6 км'});
  assert.equal(g.distance,'6 км');C.validateState(s);
});
test('a goal extracted from an unmarked note receives the same catalog, stage and distance fields',()=>{
  const {s,c}=fixture(),r=C.saveRecord(s,c.id,'Обсудили следующий сезон');
  const result=C.applyAgentResult(s,r.id,{changes:[{type:'goal',title:'Tornik Race 2027 15 км',status:'Согласовано'}]});
  const g=s.goals[result.changes[0].id];assert.equal(g.type,'race');assert.equal(g.distance,'15 км');
  assert.equal(raceById(s,g.raceId).date,'2027-05-08');assert.equal(g.raceStage,'selected');
});
test('failed goal classification cannot leave a half-created goal, and retry applies once',()=>{
  const {s,c}=fixture(),r=C.saveRecord(s,c.id,'Новый старт','goal'),before=JSON.stringify(s);
  assert.throws(()=>C.processManualRecord(s,r.id,{goalType:'race',raceId:'race-missing',raceStage:'selected'}));
  assert.equal(JSON.stringify(s),before);
  C.processManualRecord(s,r.id,{goalType:'fitness'});C.processManualRecord(s,r.id,{goalType:'fitness'});
  assert.equal(Object.keys(s.goals).length,1);
});
test('goal extraction recognizes status and type but never guesses another edition or ambiguous date',()=>{
  const {s}=fixture();
  assert.equal(goalProposal(s,'Рабочая цель тренера: улучшить физическую форму').status,'Рабочая цель тренера');
  assert.equal(goalProposal(s,'Хочу похудеть на 5 кг').type,'fitness');
  assert.equal(goalProposal(s,'Предлагаю Tornik Race 2027 15 км').distance,'15 км');
  assert.equal(goalProposal(s,'Согласовали Tornik Race 2027').status,'Согласовано');
  assert.equal(goalProposal(s,'Tornik Race 2028').raceId,null);
  C.defineRace(s,{name:'Tornik Race',date:'2028-05-01'});
  assert.equal(goalProposal(s,'Tornik Race максимальная дистанция').raceId,null);
  assert.equal(goalProposal(s,'Tornik Race максимальная дистанция').distance,null);
});
test('BMI is derived without changing measurements, uses adult boundaries, and withholds adult assessment for minors or unknown age',()=>{
  const client={training:{height:200,weight:100},profile:{birthday:'1990-01-01'}},before=JSON.stringify(client);
  assert.equal(bodyMass(client,'2026-11-20').value,25);assert.equal(bodyMass(client,'2026-11-20').tone,'attention');
  client.training.weight=99.6;assert.equal(bodyMass(client,'2026-11-20').tone,'normal');
  client.training.weight=74;assert.equal(bodyMass(client,'2026-11-20').tone,'normal');
  client.training.weight=73.6;assert.equal(bodyMass(client,'2026-11-20').tone,'attention');
  assert.equal(bodyMass({...client,profile:{birthday:'2010-01-01'}},'2026-11-20').adult,false);
  assert.equal(bodyMass({...client,profile:{}},'2026-11-20').adult,false);
  assert.equal(bodyMass({training:{height:200}}),null);
  client.training.weight=100;assert.equal(JSON.stringify(client),before);
});

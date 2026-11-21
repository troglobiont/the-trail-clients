import test from 'node:test';
import assert from 'node:assert/strict';
import {addDays,createClient,emptyState,exportState,parseImport,validateState} from '../src/core.js';
import {dayLoad,powerTss,recoveryIndex,saveSportDay,trainingLoad} from '../src/sport-log.js';

const today='2026-11-21';
const run={type:'run',minutes:60,rpe:5};
const form=(days,value)=>Object.fromEntries(Array.from({length:days},(_,index)=>[addDays(today,-index-1),value]));

test('load uses every completed session and keeps power TSS on its own scale',()=>{
  const ride={type:'bike',minutes:60,rpe:3,power:{normalized:200,threshold:250}};
  assert.equal(dayLoad({sessions:[run,ride]}),480);
  assert.equal(Math.round(powerTss(ride)),64);
  assert.equal(powerTss(run),null);
});

test('daily updates use completed work and yesterday’s balance',()=>{
  const log=form(42,{sessions:[run]});
  log[today]={sessions:[{type:'gym',minutes:45,rpe:8}]};
  const result=trainingLoad(log,today);
  assert.equal(result.atl,300+60/7);
  assert.equal(result.ctl,300+60/42);
  assert.equal(result.tsb,0);
  assert.equal(result.today,360);
  assert.equal(trainingLoad(log,addDays(today,1)).tsb,result.ctl-result.atl);
});

test('confirmed rest advances the load model and a missing day breaks continuity',()=>{
  const log=form(42,{sessions:[run]});
  log[today]={sessions:[]};
  const rest=trainingLoad(log,today);
  assert.equal(rest.today,0);
  assert(rest.atl<rest.ctl);
  delete log[addDays(today,-1)];
  assert.deepEqual(trainingLoad(log,today),{atl:null,ctl:null,tsb:null,through:today,streak:1,today:0});
  const week=trainingLoad(form(7,{sessions:[run]}),today);
  assert.equal(week.atl,300);
  assert.equal(week.ctl,null);
  assert.equal(week.tsb,null);
});

test('recovery uses personal history by source, carries zero values, and skips secondary fields',()=>{
  const standard={source:'Garmin',sleepMinutes:450,hrv:60,restingHeartRate:48,freshness:7};
  const log=form(14,standard);
  log[today]={...standard,source:' garmin ',weight:75,sleepQuality:8};
  assert.equal(recoveryIndex(log,today).value,50);
  log[today]={...standard,sleepMinutes:0,hrv:38,restingHeartRate:62,freshness:3};
  assert.equal(recoveryIndex(log,today).value,0);
  log[today]={...standard,source:'Oura'};
  assert.equal(recoveryIndex(log,today).groups,1);
  assert.equal(recoveryIndex(log,today).value,null);
  log[today]={source:'Garmin',sleepMinutes:405,freshness:6,weight:70};
  assert.equal(recoveryIndex(log,today).groups,2);
  assert(recoveryIndex(log,today).value<50);
  delete log[addDays(today,-14)];
  log[addDays(today,-29)]=standard;
  assert.equal(recoveryIndex(log,today).value,null);
});

test('sleep heart rate has its own reference and never supplies a resting HR baseline',()=>{
  const log=form(14,{source:'Oura',sleepMinutes:480,sleepHeartRate:50});
  log[today]={source:'Oura',sleepMinutes:480,restingHeartRate:54,sleepHeartRate:52};
  const current=recoveryIndex(log,today);
  assert.equal(current.groups,2);
  assert.equal(current.reference.sleepHeartRate,50);
  assert(!Object.hasOwn(current.reference,'restingHeartRate'));
});

test('athlete history survives backup, rejects future dates and malformed or stale changes',()=>{
  const state=emptyState(),client=createClient(state,{name:'Тестовый спортсмен'});
  const day={sessions:[run]};
  saveSportDay(client,'load',today,day,{today,previous:null});
  saveSportDay(client,'recovery',today,{freshness:0},{today});
  assert.deepEqual(parseImport(exportState(state)).clients[client.id].sportLog,client.sportLog);
  assert.throws(()=>saveSportDay(client,'load',today,{sessions:[]},{today,previous:null}),/уже изменилась/);
  assert.throws(()=>saveSportDay(client,'load',addDays(today,1),day,{today}),/дату/);
  assert.throws(()=>saveSportDay(client,'recovery',today,{hrv:50},{today}),/источник/);
  saveSportDay(client,'load',today,null,{today,previous:day});
  assert.equal(trainingLoad(client.sportLog.load,today).today,null);
  client.sportLog.recovery[today].freshness=11;
  assert.throws(()=>validateState(state),/историю спортсмена/);
});

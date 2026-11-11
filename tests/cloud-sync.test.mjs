import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../src/core.js';
import * as A from '../src/accounting.js';
import { createStore } from '../src/store.js';
import { createCloudSync } from '../src/cloud-sync.js';

const owner = '10000000-0000-4000-8000-000000000001';
function fixture() {
  let revision = 0, data = {}, stored = '', credentials = '', offline = false, loseResponse = false;
  const requests = new Map();
  const session = { owner, email:'owner@example.test', access:'session', refresh:'refresh', expires:Date.now()+3600000 };
  const adapter = { load:async()=>stored, save:async value=>{stored=value;} };
  const vault = { load:async()=>credentials, save:async value=>{credentials=value;} };
  const api = {
    signIn:async()=>session,
    read:async since=>{if(offline)throw Error('offline');return {revision,data:since===revision?null:C.clone(data)};},
    write:async flight=>{
      if(offline)throw Error('offline');
      if(requests.has(flight.id))return {revision:requests.get(flight.id),applied:true};
      if(flight.revision!==revision)return {revision,applied:false};
      for(const [bucket,items] of Object.entries(flight.changes))for(const [id,value] of Object.entries(items)){
        data[bucket]??={};
        if(value===null)delete data[bucket][id];else data[bucket][id]=C.clone(value);
      }
      requests.set(flight.id,++revision);
      if(loseResponse){loseResponse=false;throw Error('lost response');}
      return {revision,applied:true};
    }
  };
  return {adapter,vault,api,data:()=>data,offline:value=>{offline=value;},drop:()=>{loseResponse=true;},revision:()=>revision,
    change:(bucket,id,change)=>{Object.assign(data[bucket][id],change);revision++;}};
}

test('first sync includes existing cards and later uploads only changed records; drafts and tokens stay local',async()=>{
  const f=fixture();
  const store=await createStore(f.adapter);
  const existing=await store.mutate(s=>{
    s.settings.serviceURL='https://private.example';
    s.settings.drafts={private:{text:'draft'}};
    return C.createClient(s,{name:'Existing'});
  });
  const cloud=createCloudSync({store,api:f.api,vault:f.vault});
  await cloud.connect('owner@example.test','password');
  assert.equal(cloud.state().status,'synced');
  assert.equal(f.data().clients[existing.id].name,'Existing');
  assert.equal(f.data().settings,undefined);
  const writes=[];const original=f.api.write;f.api.write=flight=>{writes.push(flight);return original(flight);};
  const added=await store.mutate(s=>{
    const client=C.createClient(s,{name:'New gym client'});
    const date=C.localDate();
    const service=A.saveService(s,{clientId:client.id,kind:'personal',block:'personal',startsOn:date,endsOn:null,day:null,rate:400000,currency:'RSD',reminder:false,place:'Зал'});
    A.saveOperation(s,{kind:'session',serviceId:service.id,date,place:'Зал',currency:'RSD',amount:400000,note:''});
    return client;
  });
  await cloud.sync();
  assert.deepEqual(Object.keys(writes[0].changes.clients),[added.id]);
  assert.equal(Object.values(f.data().operations)[0].kind,'session');
  assert.equal(cloud.state().status,'synced');
  assert.equal(C.parseImport(C.exportState(store.state())).cloudSync,undefined);
  await cloud.disconnect();
});

test('offline writes survive restart and a lost response never duplicates an operation',async()=>{
  const f=fixture();
  let store=await createStore(f.adapter);
  let cloud=createCloudSync({store,api:f.api,vault:f.vault});
  await cloud.connect('owner@example.test','password');
  f.offline(true);
  const client=await store.mutate(s=>C.createClient(s,{name:'Offline'}));
  await cloud.sync();
  assert.equal(cloud.state().status,'error');
  assert.ok(Object.keys(store.state().cloudSync.pending).length);
  f.offline(false);f.drop();
  await cloud.sync();
  assert.ok(store.state().cloudSync.flight);
  assert.equal(f.data().clients[client.id].name,'Offline');
  await store.mutate(s=>C.editClient(s,client.id,{name:'Offline edited'}));
  store=await createStore(f.adapter);
  cloud=createCloudSync({store,api:f.api,vault:f.vault});
  await cloud.restore();
  assert.equal(cloud.state().status,'synced');
  assert.equal(f.data().clients[client.id].name,'Offline edited');
  assert.equal(f.revision(),2);
  await cloud.disconnect();
});

test('a competing edit keeps the phone version until the owner chooses',async()=>{
  const f=fixture();
  const store=await createStore(f.adapter);
  const client=await store.mutate(s=>C.createClient(s,{name:'Original'}));
  const cloud=createCloudSync({store,api:f.api,vault:f.vault});
  await cloud.connect('owner@example.test','password');
  f.change('clients',client.id,{name:'Cloud edit'});
  await store.mutate(s=>C.editClient(s,client.id,{name:'Phone edit'}));
  await cloud.sync();
  const decision=cloud.state();
  assert.equal(decision.status,'conflict');
  assert.equal(store.state().clients[client.id].name,'Phone edit');
  assert.equal(decision.conflicts[0].remote.name,'Cloud edit');
  await cloud.sync({revision:decision.revision,choices:{[decision.conflicts[0].key]:'cloud'}});
  assert.equal(store.state().clients[client.id].name,'Cloud edit');
  assert.equal(cloud.state().status,'synced');
  await cloud.disconnect();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,createClient,createTask,completeTask,exportState} from '../src/core.js';
import {createStore} from '../src/store.js';

function fixture(){
  const seed=emptyState(),client=createClient(seed,{name:'Начальный клиент'});
  const task=createTask(seed,client.id,'Начальная задача');
  const envelope=JSON.parse(exportState(seed));envelope.initialDatasetId='test-dataset-v1';
  let disk=null,writes=0;
  const adapter={async load(){return disk;},async loadInitialData(){return JSON.stringify(envelope);},async save(text){disk=text;writes++;}};
  return {seed,client,task,envelope,adapter,read:()=>disk,writes:()=>writes,set:text=>{disk=text;}};
}
test('personal installer initializes and persists the database before first use',async()=>{
  const f=fixture(),store=await createStore(f.adapter);
  assert.equal(store.state().clients[f.client.id].name,'Начальный клиент');
  assert.deepEqual(JSON.parse(f.read()).settings.initialDatasetIds,['test-dataset-v1']);
  assert.equal(f.writes(),1);
});
test('existing edits, completed tasks, drafts and defaults survive initial merge',async()=>{
  const f=fixture(),current=structuredClone(f.seed);
  current.clients[f.client.id].name='Моя правка';completeTask(current,f.task.id);
  current.settings.waitDays=3;current.settings.drafts={[f.client.id]:'Мой черновик'};
  const added=createClient(f.seed,{name:'Другой начальный клиент'});
  f.envelope.state=f.seed;f.set(JSON.stringify(current));
  const s=(await createStore(f.adapter)).state();
  assert.equal(s.clients[f.client.id].name,'Моя правка');assert.ok(s.clients[added.id]);
  assert.equal(s.tasks[f.task.id].phase,'done');assert.equal(s.settings.waitDays,3);
  assert.equal(s.settings.drafts[f.client.id],'Мой черновик');
});
test('seed marker prevents restoring removed data or duplicating it after restart',async()=>{
  const f=fixture(),store=await createStore(f.adapter);
  await store.mutate(s=>{delete s.tasks[f.task.id];s.clients[f.client.id].name='После запуска';});
  const writes=f.writes(),again=await createStore(f.adapter);
  assert.equal(again.state().clients[f.client.id].name,'После запуска');
  assert.equal(again.state().tasks[f.task.id],undefined);assert.equal(f.writes(),writes);
});
test('failed initial save can be retried and never writes a separate applied marker',async()=>{
  const f=fixture();let fail=true;
  const adapter={...f.adapter,async save(text){if(fail)throw Error('disk full');await f.adapter.save(text);}};
  await assert.rejects(createStore(adapter),/disk full/);assert.equal(f.read(),null);
  fail=false;assert.ok((await createStore(adapter)).state().clients[f.client.id]);
});
test('corrupt local or initial database is never replaced by a fresh database',async()=>{
  const f=fixture();f.set('not json');
  await assert.rejects(createStore(f.adapter),/Не удалось прочитать базу/);assert.equal(f.writes(),0);
  f.set(null);f.envelope.state.clients[f.client.id].status='invalid';
  await assert.rejects(createStore(f.adapter));assert.equal(f.writes(),0);
});
test('public installer with no optional data stays empty and does not write a seed marker',async()=>{
  let writes=0;const store=await createStore({async load(){return null;},async loadInitialData(){return null;},async save(){writes++;}});
  assert.equal(Object.keys(store.state().clients).length,0);assert.equal(writes,0);
});

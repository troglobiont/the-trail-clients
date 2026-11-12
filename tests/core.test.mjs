import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.js';
import {createStore} from '../src/store.js';
function fixture(){const s=C.emptyState();const a=C.createClient(s,{name:'Клиент А',format:'Дистанционно',level:'Премиум',personal:'none',basis:'С нуля'});const b=C.createClient(s,{name:'Клиент Б',format:'Очно',level:'Обычное',personal:'gym',basis:'Hard'});return {s,a,b};}
test('classification fields are independent and Cyrillic aliases searchable',()=>{const {s,a,b}=fixture();s.clients[a.id].aliases=['Shalaev'];assert.equal(C.filterClients(s,{format:'Дистанционно',level:'Премиум'})[0].id,a.id);assert.equal(C.filterClients(s,{personal:'gym'})[0].id,b.id);assert.equal(C.filterClients(s,{query:'Шалаев'})[0].id,a.id);assert.equal(C.filterClients(s,{status:'На паузе'}).length,0);C.validateState(s);});
test('unlinking and restoring a Telegram recipient preserves client history and tasks across persistence',async()=>{
  const {s,a,b}=fixture(),binding={peerId:'123456',displayName:'Тестовый получатель',accountPeerId:'654321'};
  const t=C.createTask(s,a.id,'Спросить о тренировке',{needsReply:true}),r=C.saveRecord(s,a.id,'Тестовая запись');
  C.setTelegramBinding(s,a.id,binding);C.markSent(s,t.id,'2026-11-10T07:00:00Z');
  const before=C.clone(s),previous=C.clone(s.clients[a.id].telegram);
  C.setTelegramBinding(s,a.id,null);assert.equal(s.clients[a.id].telegram,null);
  const saved=C.parseImport(C.exportState(s));assert.deepEqual(saved.tasks[t.id],before.tasks[t.id]);assert.deepEqual(saved.records[r.id],before.records[r.id]);assert.deepEqual(saved.clients[b.id],before.clients[b.id]);
  C.setTelegramBinding(saved,a.id,previous);previous.displayName='Changed outside store';
  assert.deepEqual(saved.clients[a.id].telegram,binding);assert.equal(saved.events.filter(e=>e.type==='outbound').length,1);
  assert.equal(saved.events.filter(e=>e.type==='telegram-unlinked').length,1);assert.equal(saved.events.filter(e=>e.type==='telegram-linked').length,2);
});
test('a pending Telegram send prevents changing or unlinking its recipient atomically',()=>{
  const {s,a}=fixture(),binding={peerId:'123456',displayName:'Тестовый получатель'};
  C.setTelegramBinding(s,a.id,binding);s.settings.pendingTelegram={[a.id]:{key:'message-1',text:'Привет'}};
  const before=JSON.stringify(s);
  for(const value of [null,{peerId:'789012',displayName:'Другой'}])assert.throws(()=>C.setTelegramBinding(s,a.id,value),/неподтверждённую отправку/);
  assert.equal(JSON.stringify(s),before);
});
test('one record can produce two independent tasks; completing one retains the other',()=>{const {s,a}=fixture();const one=C.createTask(s,a.id,'Добавить домашний блок'),two=C.createTask(s,a.id,'Спросить о самочувствии',{due:'2026-11-11'});C.completeTask(s,one.id);assert.deepEqual(C.openTasks(s).map(x=>x.id),[two.id]);assert.equal(s.tasks[one.id].phase,'done');C.completeTask(s,one.id,false);assert.equal(C.openTasks(s).length,2);});
test('editing an existing action retains identity, source and reply lifecycle through persistence',async()=>{
  const {s,a}=fixture(),r=C.saveRecord(s,a.id,'Попросить сходить в кино в среду, в среду попросить');
  C.applyAgentResult(s,r.id,{changes:[{type:'task',title:'Попросить сходить в кино',due:'2026-11-11',needsReply:true}]});
  const t=C.openTasks(s)[0];C.markSent(s,t.id,'2026-11-11T09:00:00Z');
  const before=C.clone(t);let saved;
  const store=await createStore({async load(){return JSON.stringify(s);},async save(value){saved=value;}});
  await store.mutate(next=>C.editTask(next,t.id,'  Предложить кино на выходных  ','2026-11-13'));
  const restored=JSON.parse(saved),edited=restored.tasks[t.id];C.validateState(restored);
  assert.equal(edited.title,'Предложить кино на выходных');assert.equal(edited.due,'2026-11-13');
  for(const key of ['id','clientId','sourceRecordId','needsReply','phase','checkOn','lastSentAt','outboundCount','lane','waitDays','closedAt'])assert.deepEqual(edited[key],before[key],key);
  assert.equal(Object.keys(restored.tasks).length,1);assert.equal(restored.records[r.id].text,r.text);
  const e=restored.events.find(e=>e.type==='task-edited');assert.deepEqual(e.before,{title:before.title,due:before.due});assert.deepEqual(e.after,{title:edited.title,due:edited.due});
  C.applyAgentResult(restored,r.id,{changes:[{type:'task',title:'Попросить сходить в кино',due:'2026-11-11'}]});
  assert.equal(restored.tasks[t.id].title,'Предложить кино на выходных');assert.equal(Object.keys(restored.tasks).length,1);
});
test('editing completed actions does not reopen them; invalid edits leave the action unchanged',()=>{
  const {s,a}=fixture(),t=C.createTask(s,a.id,'Спросить завтра',{due:'2026-11-10'});C.completeTask(s,t.id);
  const closedAt=t.closedAt;C.editTask(s,t.id,'Спросить о самочувствии',null);
  assert.equal(t.phase,'done');assert.equal(t.closedAt,closedAt);assert.equal(t.due,null);assert.equal(C.openTasks(s).length,0);
  const before=JSON.stringify(s);
  for(const [title,due] of [['  ',null],['x'.repeat(1001),null],['Правка','2026-02-30'],['Правка','среда']])assert.throws(()=>C.editTask(s,t.id,title,due));
  assert.equal(JSON.stringify(s),before);assert.throws(()=>C.editTask(s,'missing','Правка'));
  C.editTask(s,t.id,t.title,t.due);assert.equal(JSON.stringify(s),before);
});
test('reply task moves check from actual send date without completing; duplicate mark guarded',()=>{const {s,a}=fixture();const t=C.createTask(s,a.id,'Спросить о тренировке',{needsReply:true,due:'2026-11-11'});C.markSent(s,t.id,'2026-11-11T08:00:00.000Z');assert.equal(t.checkOn,'2026-11-13');assert.equal(t.phase,'waiting');C.markSent(s,t.id,'2026-11-11T08:00:01.000Z');assert.equal(t.outboundCount,1);C.markSent(s,t.id,'2026-11-13T09:00:00.000Z');assert.equal(t.checkOn,'2026-11-15');assert.equal(t.outboundCount,2);assert.equal(C.taskWarning(t,'2026-11-14'),null);assert.equal(C.taskWarning(t,'2026-11-15').level,'warning');C.markSent(s,t.id,'2026-11-15T09:00:00.000Z');assert.equal(C.taskWarning(t,'2026-11-17').level,'danger');C.completeTask(s,t.id);assert.equal(s.events.filter(e=>e.type==='incoming').length,0);});
test('confirmed message idempotency is stable beyond double-click window',()=>{const {s,a}=fixture();const t=C.createTask(s,a.id,'Вопрос',{needsReply:true});C.markSent(s,t.id,'2026-11-11T08:00:00Z','peer-1:msg-1');C.markSent(s,t.id,'2026-11-12T08:00:00Z','peer-1:msg-1');assert.equal(t.outboundCount,1);});
test('wait setting only affects one task and explicit default for future tasks',()=>{const {s,a}=fixture();const one=C.createTask(s,a.id,'Один',{needsReply:true}),two=C.createTask(s,a.id,'Два',{needsReply:true});C.markSent(s,one.id,'2026-11-11T09:00:00Z');C.setWait(s,one.id,3,true);assert.equal(one.checkOn,'2026-11-14');assert.equal(two.waitDays,2);assert.equal(C.createTask(s,a.id,'Новый').waitDays,3);});
test('discussion moves to current lane without duplication or starting reply timer',()=>{const {s,a}=fixture();const t=C.createTask(s,a.id,'Обсудить цель',{lane:'discussion',needsReply:true});assert.equal(C.openTasks(s).length,0);C.scheduleTask(s,t.id,'2026-11-15');assert.equal(C.openTasks(s).length,1);assert.equal(Object.keys(s.tasks).length,1);assert.equal(t.checkOn,null);});
test('goal edits, soft delete and restore retain title and create no task',()=>{const {s,a}=fixture();const g=C.addGoal(s,a.id,'Полумарафон');C.editGoal(s,g.id,'Полумарафон уверенно','Согласовано');C.deleteGoal(s,g.id);assert.ok(g.deletedAt);C.deleteGoal(s,g.id,false);assert.equal(g.title,'Полумарафон уверенно');assert.equal(g.status,'Согласовано');assert.equal(g.deletedAt,null);assert.equal(Object.keys(s.tasks).length,0);assert.throws(()=>C.editGoal(s,g.id,'','Согласовано'));});
test('same goal title updates existing agreement rather than duplicating',()=>{const {s,a}=fixture();const g=C.addGoal(s,a.id,'Десятка в Белграде');C.addGoal(s,a.id,'Десятка в Белграде','Согласовано');assert.equal(Object.keys(s.goals).length,1);assert.equal(g.status,'Согласовано');});
test('processing same record is idempotent; note alone creates no task',()=>{const {s,a}=fixture();const note=C.saveRecord(s,a.id,'Обсудили планы','record');C.processManualRecord(s,note.id);assert.equal(C.openTasks(s).length,0);const r=C.saveRecord(s,a.id,'Спросить в среду','task');C.processManualRecord(s,r.id,{due:'2026-11-11'});C.processManualRecord(s,r.id,{due:'2026-11-11'});assert.equal(Object.keys(s.tasks).length,1);});
test('agent result is applied atomically; foreign goal and bad enum rejected',()=>{const {s,a,b}=fixture();const g=C.addGoal(s,b.id,'Чужая цель');const r=C.saveRecord(s,a.id,'Запись');const before=JSON.stringify(s);assert.throws(()=>C.applyAgentResult(s,r.id,{changes:[{type:'task',title:'Можно'},{type:'goal',id:g.id,title:'Чужое',status:'Согласовано'}]}));assert.equal(JSON.stringify(s),before);assert.throws(()=>C.applyAgentResult(s,r.id,{changes:[{type:'goal',title:'Цель',status:'Уже оплачено'}]}));});
test('agent can create independent actions and update a known goal once',()=>{const {s,a}=fixture();const g=C.addGoal(s,a.id,'Десятка');const r=C.saveRecord(s,a.id,'Согласовали десятку, добавить блок и спросить в среду');const changes={changes:[{type:'goal',id:g.id,title:'Десятка',status:'Согласовано'},{type:'task',title:'Добавить блок'},{type:'task',title:'Спросить самочувствие',due:'2026-11-11'}]};C.applyAgentResult(s,r.id,changes);C.applyAgentResult(s,r.id,changes);assert.equal(Object.keys(s.tasks).length,2);assert.equal(Object.keys(s.goals).length,1);assert.equal(s.goals[g.id].status,'Согласовано');});
test('archiving a feature preserves history and does not imply health recovery',()=>{const {s,a}=fixture();const f=C.addFeature(s,a.id,'Болеет, возврат неизвестен');C.setFeatureActive(s,a.id,f.id,false);assert.equal(s.clients[a.id].features.length,1);assert.equal(f.active,false);assert.ok(s.events.find(e=>e.type==='feature-archived'));assert.equal(s.clients[a.id].lastContact,null);});
test('editing a saved feature preserves lines, identity and archived status through persistence', async () => {
  const { s, a } = fixture();
  const record = C.saveRecord(s, a.id, 'Сведения для карточки');
  const feature = C.addFeature(s, a.id, 'Первоначальная запись', 'Сейчас', record.id);
  C.setFeatureActive(s, a.id, feature.id, false);
  let saved = JSON.stringify(s);
  const store = await createStore({ async load() { return saved; }, async save(value) { saved = value; } });
  const note = 'Первая строка\n\nВторая строка';

  await assert.rejects(store.mutate(next => C.editFeature(next, a.id, feature.id, ' \n ', 'Сейчас')), /Введи особенность/);
  assert.equal(store.state().clients[a.id].features[0].text, feature.text);
  await store.mutate(next => C.editFeature(next, a.id, feature.id, `  ${note}  `, 'Постоянно учитывать'));

  const restored = C.validateState(JSON.parse(saved));
  assert.deepEqual(restored.clients[a.id].features, [{ ...feature, text: note, kind: 'Постоянно учитывать' }]);
  assert.equal(restored.records[record.id].text, record.text);
  const edits = () => restored.events.filter(event => event.type === 'feature-edited');
  assert.equal(edits()[0].text, note);
  assert.deepEqual(edits()[0].before, { text: feature.text, kind: feature.kind });
  C.editFeature(restored, a.id, feature.id, note, 'Постоянно учитывать');
  assert.equal(edits().length, 1);
});
test('backup is validated, merge does not overwrite newer local edits',()=>{const {s,a}=fixture();const initial=C.parseImport(C.exportState(s));s.clients[a.id].name='Новая правка';const merged=C.mergeState(s,initial);assert.equal(merged.clients[a.id].name,'Новая правка');assert.throws(()=>C.parseImport('{"format":"other"}'));const unsafe=JSON.parse(C.exportState(s));Object.defineProperty(unsafe.state.clients,'__proto__',{value:{},enumerable:true});assert.throws(()=>C.parseImport(JSON.stringify(unsafe)));});
test('failed disk save leaves committed state unchanged; next save still succeeds',async()=>{let text=null,fail=true;const store=await createStore({async load(){return text;},async save(next){if(fail)throw Error('disk full');text=next;}});await assert.rejects(store.mutate(s=>C.createClient(s,{name:'Не сохранён'})));assert.equal(Object.keys(store.state().clients).length,0);fail=false;await store.mutate(s=>C.createClient(s,{name:'Сохранён'}));const restored=await createStore({async load(){return text;},async save(){}});assert.equal(Object.values(restored.state().clients)[0].name,'Сохранён');});
test('serialized writes retain both simultaneous changes',async()=>{let text=null;const store=await createStore({async load(){return null;},async save(next){await new Promise(r=>setTimeout(r,5));text=next;}});await Promise.all([store.mutate(s=>C.createClient(s,{name:'Один'})),store.mutate(s=>C.createClient(s,{name:'Два'}))]);assert.equal(Object.keys(JSON.parse(text).clients).length,2);assert.equal(store.state().revision,2);});

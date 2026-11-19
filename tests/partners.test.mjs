import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,validateState,exportState,parseImport,mergeState} from '../src/core.js';
import {savePartner,savePartnerTask,completePartnerTask,partnerTasks,savePartnerTerm,termConfirmation,partnerURL} from '../src/partners.js';
import {beginCloudSync,cloudData,prepareCloudWrite,receiveCloudData} from '../src/cloud-state.js';

const owner='10000000-0000-4000-8000-000000000001';
const partner=state=>savePartner(state,{name:'Тестовый партнёр',category:'Экипировка',relationshipStatus:'owner_confirmed',
  confirmation:{level:'owner_statement',date:'2026-11-19'},benefits:[{id:'demo-term',description:'Клубная скидка',discountPercent:null,price:null}]});

test('partners and their tasks are independent of clients, tariffs and accounting',()=>{
  const s=emptyState(),p=partner(s);
  const task=savePartnerTask(s,p.id,{title:'Уточнить порядок скидки',due:'2026-11-25'});
  assert.equal(Object.keys(s.clients).length,0);
  assert.equal(s.accounting,undefined);
  assert.equal(partnerTasks(s,p.id)[0].id,task.id);
  completePartnerTask(s,task.id);
  assert.equal(partnerTasks(s,p.id).length,0);
  assert.equal(partnerTasks(s,p.id,true).length,1);
  completePartnerTask(s,task.id,false);
  savePartnerTask(s,p.id,{id:task.id,title:task.title,due:null});
  assert.equal(task.due,'2026-11-25'); // The replaced record never mutates a held view.
  assert.equal(partnerTasks(s,p.id)[0].due,null);
  validateState(s);
  assert.throws(()=>savePartnerTask(s,'missing',{title:'bad'}),/не найден/u);
  assert.throws(()=>savePartner(s,{id:p.id,name:''}),/Некорректная/u);
});

test('unknown terms stay null; editing is a dated owner statement and preserves earlier sources as history',()=>{
  const s=emptyState(),p=partner(s);
  p.confirmation.level='counterparty_email';p.benefits[0].sourceIds=['email-one'];
  assert.equal(p.benefits[0].discountPercent,null);
  savePartnerTerm(s,p.id,{id:'demo-term',description:'Новое условие',discountPercent:10,price:null,confirmedOn:'2026-11-20'});
  const term=s.partners[p.id].benefits[0];
  assert.deepEqual(termConfirmation(s.partners[p.id],term),{level:'owner_statement',date:'2026-11-20'});
  assert.deepEqual(term.sourceIds,[]);assert.deepEqual(term.previousSourceIds,['email-one']);
  assert.equal(term.price,null);
  assert.throws(()=>savePartnerTerm(s,p.id,{id:'demo-term',discountPercent:120}),/условия/u);
  assert.equal(s.partners[p.id].benefits[0].discountPercent,10);
});

test('partner edits are synchronized as individual records with ordinary conflict resolution',()=>{
  const s=emptyState(),p=partner(s);
  beginCloudSync(s,owner);
  receiveCloudData(s,{revision:1,data:cloudData(s)});
  const remote=structuredClone(cloudData(s));
  const before=structuredClone(s);
  savePartner(s,{id:p.id,name:'Локальное имя'});
  // Track changes as the real store does.
  return import('../src/cloud-state.js').then(({trackCloudChanges})=>{
    trackCloudChanges(before,s);
    assert.deepEqual(Object.keys(prepareCloudWrite(s).changes),['partners']);
    s.cloudSync.flight=null;remote.partners[p.id].name='Имя в облаке';
    const conflicts=receiveCloudData(s,{revision:2,data:remote});
    assert.equal(conflicts.length,1);assert.equal(conflicts[0].key,'partners/'+p.id);
    assert.equal(s.partners[p.id].name,'Локальное имя');
    receiveCloudData(s,{revision:2,data:remote},{['partners/'+p.id]:'cloud'});
    assert.equal(s.partners[p.id].name,'Имя в облаке');
  });
});

test('backup restores partner data and tasks and importing an old backup preserves them',()=>{
  const s=emptyState(),p=partner(s);savePartnerTask(s,p.id,{title:'Позвонить',due:null});
  const restored=parseImport(exportState(s));
  assert.deepEqual(restored.partners,s.partners);assert.deepEqual(restored.partnerTasks,s.partnerTasks);
  const merged=mergeState(restored,emptyState());
  assert.deepEqual(merged.partners,s.partners);
  const fresh=mergeState(emptyState(),restored);assert.equal(partnerTasks(fresh).length,1);
  assert.equal(partnerURL('javascript:alert(1)'),null);
  assert.equal(partnerURL('https://password@example.test'),null);
  assert.equal(partnerURL('https://example.test'),'https://example.test/');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../src/core.js';
import { clientAccountHistory, combinedSummary, matchingTariffClients, monthlyCharge, personalBalances, saveOperation, saveService } from '../src/accounting.js';
import { applyLedger, changeImportedPayment, ledgerRows } from '../src/ledger-import.js';

const source = 'https://docs.google.com/spreadsheets/d/source/edit#gid=42';
const binding = id => ({ peerId: id, accountPeerId: '10', displayName: 'Контакт', username: null, verifiedAt: '2026-01-01T00:00:00Z' });

test('re-import retains itemized historical sessions without creating receipts or debt', () => {
  const state=C.emptyState();
  const client=C.createClient(state,{id:'client-1',name:'Клиент Тест'},'2026-01-01');
  const common={block:'personal',owners:[client.id],name:client.name,link:source};
  const original={...common,id:'original',month:'2026-02',kind:'session',date:'',detail:'2 зан. × 4000 RSD',values:{RSD:800000}};
  const months=['2026-01','2026-02'].map(month=>({month,blocks:{},link:source}));
  const sessions=['2026-01-30','2026-02-02'].map(date=>({...original,id:'visit-'+date,month:date.slice(0,7),date,
    place:'Зал',sourceLedgerRowId:original.id,detail:'1 зан. × 4000 RSD',values:{RSD:400000}}));
  state.ledger={datasetId:'old',asOf:'2026-02-03',months,rows:[{...original,kind:'repeat',sourceKind:'session'},...sessions]};
  const file={format:'the-trail-ledger-import',version:1,datasetId:'new',asOf:'2026-02-04',months,rows:[original],
    profiles:[{id:client.id,name:client.name,role:'Клиент',aliases:[],create:false}]};
  applyLedger(state,file,{createClient:C.createClient,setTelegramBinding:C.setTelegramBinding});
  assert.doesNotThrow(()=>C.validateState(state));
  assert.deepEqual(clientAccountHistory(state,client.id).map(item=>item.date),['2026-02-02','2026-01-30']);
  assert.equal(combinedSummary(state,'2026-01').count,1);
  assert.deepEqual(combinedSummary(state,'2026-02').sessions,{RSD:400000});
  assert.deepEqual(combinedSummary(state,'2026-02').receipts,{});
  assert.deepEqual(personalBalances(state),{advance:{},debt:{}});
});

test('ledger import is idempotent and keeps local Telegram, task history and client IDs', () => {
  const state = C.emptyState();
  const card = C.createClient(state, { name: 'Marina Druzyk', telegram: binding('20') }, '2026-01-01');
  C.createTask(state, card.id, 'Проверить план');
  const importedId = 'legacy-card';
  const file = {
    format: 'the-trail-ledger-import', version: 1, datasetId: 'ledger-2026-test', asOf: '2026-02-01',
    profiles: [{ id: importedId, name: 'Друзык Марина', aliases: ['Marina Druzyk'], role: 'Клиент', create: true, telegram: binding('21') }],
    months: [{ month: '2026-01', blocks: { online: { EUR: 9400 } }, link: source }],
    rows: [{ id: 'source-row', month: '2026-01', block: 'online', kind: 'payment', owners: [importedId], date: '2026-01-25',
      name: 'Друзык Марина', detail: '', values: { EUR: 9400 }, link: source + '&range=D1:J1' }]
  };
  const callbacks = { createClient: C.createClient, setTelegramBinding: C.setTelegramBinding };
  assert.deepEqual(applyLedger(state, file, callbacks), { matched: 1, created: 0, bound: 0, rows: 1 });
  assert.equal(applyLedger(state, file, callbacks), null);
  assert.equal(state.clients[card.id].telegram.peerId, '20');
  assert.equal(Object.keys(state.tasks).length, 1);
  assert.equal(state.clients[card.id].name, 'Друзык Марина');
  const roundTrip = C.parseImport(C.exportState(state));
  assert.equal(ledgerRows(roundTrip, { clientId: card.id })[0].values.EUR, 9400);
  assert.deepEqual(C.mergeState(roundTrip, roundTrip).ledger, roundTrip.ledger);
});

test('an existing amount correction can change date and currency while retaining the paid month', () => {
  const state = C.emptyState();
  const card = C.createClient(state,{name:'Клиент Тест'},'2026-01-01');
  const original = {id:'july-receipt',month:'2026-07',block:'online',package:'online',kind:'payment',owners:[card.id],
    name:'Клиент Тест',date:'2026-07-01',detail:'',values:{RUB:800000},link:source};
  const file = {format:'the-trail-ledger-import',version:1,asOf:'2026-07-03',months:[{month:original.month,blocks:{},link:source}],
    profiles:[{id:card.id,name:card.name,aliases:[],role:'Клиент',create:false}]};
  const load = (datasetId,row)=>applyLedger(state,{...file,datasetId,rows:[row]},C);
  load('first',original);
  const previous = {...original,values:{RUB:600000},originalPaymentAmount:800000};
  state.ledger.rows[0] = previous;
  assert.doesNotThrow(()=>C.validateState(state));
  const service = saveService(state,{clientId:card.id,kind:'online',block:'online',currency:'RUB',rate:600000,day:3,reminder:true,
    startsOn:'2026-01-01',endsOn:null,place:null});
  const correction = {date:'2026-08-02',entries:[{from:'RUB',currency:'EUR',amount:6500}]};
  const corrected = changeImportedPayment(state,previous,correction);
  assert.throws(()=>changeImportedPayment(state,previous,correction),/Запись изменилась/);
  assert.deepEqual(corrected.paymentOriginal,{date:original.date,values:{RUB:800000}});
  const updatedSource = {...original,date:correction.date,values:{EUR:6500}};
  for(const [id,row] of [['stale',original],['updated',updatedSource]]) {
    load(id,row);
    assert.deepEqual(clientAccountHistory(state,card.id).map(item=>item.row),[corrected]);
    assert.deepEqual(combinedSummary(state,'2026-07').receipts,{});
    assert.deepEqual(combinedSummary(state,'2026-08').services.online,{EUR:6500});
    assert.equal(monthlyCharge(state,service,'2026-07','2026-08-03').remaining,0);
    assert.equal(monthlyCharge(state,service,'2026-07','2026-08-03').lastPaidOn,'2026-08-02');
    assert.equal(monthlyCharge(state,service,'2026-08','2026-08-03').remaining,600000);
    assert.doesNotThrow(()=>C.parseImport(C.exportState(state)));
  }
});

test('a shared imported payment can change its receipt date, currency and amounts without changing its owners or splitting cash twice', () => {
  const state = C.emptyState();
  const cards = ['Первый Тест','Второй Тест'].map(name=>C.createClient(state,{name},'2026-01-01'));
  const original = {id:'joint-receipt',month:'2026-07',block:'online',kind:'shared',owners:cards.map(card=>card.id),
    name:'Семья',date:'',detail:'',values:{RUB:800000,USD:3000},packageParts:{RUB:{online:600000,trainingpeaks:200000}},link:source};
  state.ledger = {datasetId:'test',asOf:'2026-08-05',months:[{month:original.month,blocks:{},link:source}],rows:[original]};
  const date = '2026-07-02';
  const parts = {online:5000,trainingpeaks:2000};
  assert.throws(()=>changeImportedPayment(state,original,{date,entries:[
    {from:'RUB',currency:'USD',amount:7000,parts},{from:'USD',currency:'USD',amount:3000}]}),/разные валюты/);
  assert.throws(()=>changeImportedPayment(state,original,{date,entries:[
    {from:'RUB',currency:'EUR',amount:7100,parts},{from:'USD',currency:'USD',amount:3000}]}),/совпадать/);
  const updated = changeImportedPayment(state,original,{date,entries:[
    {from:'RUB',currency:'EUR',amount:7000,parts},{from:'USD',currency:'USD',amount:3000}]});
  assert.deepEqual(updated.owners, original.owners);
  for (const card of cards) assert.equal(clientAccountHistory(state,card.id)[0].date,date);
  const summary = combinedSummary(state,'2026-07');
  assert.deepEqual(summary.receipts,{EUR:7000,USD:3000});
  assert.deepEqual(summary.services.trainingpeaks,{EUR:2000});
  assert.doesNotThrow(()=>C.parseImport(C.exportState(state)));
});

test('editing a native receipt already matched to the ledger does not restore the imported duplicate', () => {
  const state = C.emptyState();
  const card = C.createClient(state,{name:'Клиент Тест'},'2026-01-01');
  const service = saveService(state,{clientId:card.id,kind:'online',block:'online',currency:'RUB',rate:600000,day:3,reminder:true,
    startsOn:'2026-01-01',endsOn:null,place:null});
  const original = {id:'same-receipt',month:'2026-07',block:'online',package:'online',kind:'payment',owners:[card.id],
    name:card.name,date:'2026-07-31',detail:'',values:{RUB:600000},link:source};
  state.ledger = {datasetId:'test',asOf:'2026-08-05',months:[{month:original.month,blocks:{},link:source}],rows:[original]};
  const allocation = {serviceId:service.id,month:'2026-07',part:600000,credit:600000};
  const receipt = {kind:'payment',currency:'RUB',date:original.date,amount:600000,payer:'',note:'',allocations:[allocation]};
  const native = saveOperation(state,receipt);
  assert.deepEqual(combinedSummary(state,'2026-07').receipts,{RUB:600000});
  assert.equal(clientAccountHistory(state,card.id).length,1);
  saveOperation(state,{...receipt,date:'2026-08-03',currency:'EUR',amount:6000,allocations:[{...allocation,part:6000}]},native.id);
  assert.deepEqual(combinedSummary(state,'2026-07').receipts,{});
  assert.deepEqual(combinedSummary(state,'2026-08').receipts,{EUR:6000});
  assert.equal(monthlyCharge(state,service,'2026-07','2026-08-04').lastPaidOn,'2026-08-03');
  assert.equal(clientAccountHistory(state,card.id).length,1);
  assert.equal(matchingTariffClients(state,{packageFilter:'all',tariffCurrency:'all',paymentCurrency:'RUB',paymentMonth:'2026-07'}).size,0);
  assert.doesNotThrow(()=>C.parseImport(C.exportState(state)));
});

test('directory filters names in either order and keeps surname order under quick filters', () => {
  const state = C.emptyState();
  C.createClient(state, { name: 'Друзык Марина', aliases: ['Marina Druzyk'], format: 'Дистанционно' }, '2026-01-01');
  C.createClient(state, { name: 'Арендарь Александра', format: 'Очно', personal: 'gym' }, '2026-01-01');
  C.createClient(state, { name: 'Гилажев Айдар', format: 'Очно', personal: 'gym' }, '2026-01-01');
  assert.deepEqual(C.filterClients(state, { quick: 'gym' }).map(c => c.name), ['Арендарь Александра', 'Гилажев Айдар']);
  assert.deepEqual(C.filterClients(state, { quick: 'Дистанционно', query: 'Марина Друзык' }).map(c => c.name), ['Друзык Марина']);
  assert.deepEqual(C.filterClients(state, { query: 'Druzyk Marina' }).map(c => c.name), ['Друзык Марина']);
});

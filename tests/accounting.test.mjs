import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/accounting.js';
import { createClient, createTask, editClient, emptyState, exportState, mergeState, parseImport } from '../src/core.js';
import { createStore } from '../src/store.js';
import { beginCloudSync } from '../src/cloud-state.js';

function enrollment(state, client, overrides = {}) {
  return A.saveService(state, {
    clientId: client.id, kind: 'belgrade', block: 'belgrade', startsOn: '2024-10-01', endsOn: null,
    day: 24, rate: 800000, currency: 'RSD', reminder: true, place: null, ...overrides
  });
}

function payment(state, date, currency, amount, allocations) {
  return A.saveOperation(state, { kind: 'payment', date, currency, amount, allocations, payer: '', note: '' });
}

const credit = (service, month, part, credited = part) => ({ serviceId: service.id, month, part, credit: credited });

test('tariff currency is matched on the selected package independently of actual receipt currency', () => {
  const s = emptyState();
  const first = createClient(s,{name:'Первый'},'2024-10-01');
  const second = createClient(s,{name:'Второй'},'2024-10-01');
  const online = enrollment(s,first,{kind:'online',block:'online',currency:'EUR',rate:8000});
  enrollment(s,second,{kind:'online',block:'online',currency:'RSD'});
  enrollment(s,second,{kind:'coaching',package:'gym',currency:'EUR'});
  payment(s,'2024-11-03','RSD',900000,[credit(online,'2024-11',900000,8000)]);
  assert.deepEqual([...A.matchingTariffClients(s,{packageFilter:'all-online',tariffCurrency:'EUR',paymentCurrency:'RSD',
    paymentMonth:'2024-11'},'2024-11-10')],[first.id]);
  assert.deepEqual([...A.matchingTariffClients(s,{packageFilter:'gym',tariffCurrency:'EUR',paymentCurrency:'all'},'2024-11-10')],[second.id]);
});

test('imported coverage and opening advances suppress duplicate bills without creating receipts', () => {
  const s = emptyState();
  const c = createClient(s,{name:'Клиент'},'2024-10-01');
  const recurring = enrollment(s,c,{billingFrom:'2024-11',coveredThrough:'2024-12'});
  const personal = enrollment(s,c,{kind:'personal',block:'personal',place:'Улица',day:null,reminder:false,rate:400000,
    openingCredit:{amount:3200000,date:'2024-11-12'}});
  assert.equal(A.monthlyCharge(s,recurring,'2024-12','2024-12-26').remaining,0);
  assert.deepEqual(A.paymentReminders(s,'2024-12-26'),[]);
  assert.deepEqual(A.paymentReminders(s,'2025-01-24').map(r=>r.month),['2025-01']);
  A.saveOperation(s,{kind:'session',serviceId:personal.id,date:'2024-11-13',place:'Улица',currency:'RSD',amount:400000,note:''});
  assert.equal(A.serviceBalance(s,personal.id,'2024-11-14').balance,2800000);
  assert.deepEqual(A.summarize(s,'2024-11').receipts,{});
});

test('one payment counts once by receipt date while covering several people, currencies and months', () => {
  const state = emptyState();
  const first = createClient(state, { name: 'Первый' }, '2024-10-01');
  const second = createClient(state, { name: 'Второй' }, '2024-10-01');
  const a = enrollment(state, first);
  const b = enrollment(state, second, { kind: 'online', block: 'online', currency: 'EUR', rate: 8000 });
  const allocation = [credit(a, '2024-10', 7000, 800000), credit(a, '2024-11', 7000, 800000), credit(b, '2024-10', 8000)];
  assert.throws(() => payment(state, '2024-11-01', 'EUR', 22001, allocation), /распределения/);
  assert.equal(A.operations(state).length, 0);
  payment(state, '2024-11-01', 'EUR', 22000, allocation);
  assert.deepEqual(A.summarize(state, '2024-10').receipts, {});
  const summary = A.summarize(state, '2024-11');
  assert.deepEqual(summary.receipts, { EUR: 22000 });
  assert.deepEqual(summary.blocks, { belgrade: { EUR: 14000 }, online: { EUR: 8000 } });
  assert.equal(A.monthlyCharge(state, a, '2024-10', '2024-11-10').remaining, 0);
  assert.deepEqual(A.paymentReminders(state, '2024-11-24').map(r => r.service.id), [b.id]);
});

test('partial payment keeps the reminder, full payment closes it and voiding restores it', () => {
  const state = emptyState();
  const client = createClient(state, { name: 'Клиент' }, '2024-10-01');
  const service = enrollment(state, client);
  assert.equal(A.paymentReminders(state, '2024-10-20').length, 0);
  const partial = payment(state, '2024-10-21', 'RSD', 300000, [credit(service, '2024-10', 300000)]);
  assert.equal(A.paymentReminders(state, '2024-10-21')[0].remaining, 500000);
  const rest = payment(state, '2024-10-22', 'RSD', 500000, [credit(service, '2024-10', 500000)]);
  assert.equal(A.paymentReminders(state, '2024-10-22').length, 0);
  A.setVoided(state, rest.id, true);
  assert.equal(A.paymentReminders(state, '2024-10-22')[0].remaining, 500000);
  assert.equal(A.summarize(state, '2024-10').receipts.RSD, partial.amount);
  assert.equal(A.operations(state, { includeVoided: true }).length, 2);
});

test('pauses stay distinct from endings and suppress charges due during a recorded pause', () => {
  const state = emptyState();
  const client = createClient(state, { name: 'Клиент' }, '2024-10-01');
  const service = enrollment(state, client, { day: 31 });
  editClient(state, client.id, { status: 'На паузе' }, '2024-10-30');
  assert.deepEqual(A.paymentReminders(state, '2024-10-31'), []);
  editClient(state, client.id, { status: 'Активный' }, '2024-11-03');
  assert.deepEqual(A.movementFor(state, '2024-10').map(e => e.movement), ['paused', 'new']);
  assert.deepEqual(A.movementFor(state, '2024-11').map(e => e.movement), ['returned']);
  assert.deepEqual(A.paymentReminders(state, '2024-11-27').map(r => [r.service.id, r.due]), [[service.id, '2024-11-30']]);
});

test('sessions consume advances without increasing receipts and expenses affect only the balance', () => {
  const state = emptyState();
  const client = createClient(state, { name: 'Клиент' }, '2024-10-01');
  const service = enrollment(state, client, { kind: 'personal', block: 'personal', day: null, reminder: false, place: 'Улица', rate: 400000 });
  payment(state, '2024-11-05', 'RSD', 4000000, [credit(service, null, 4000000)]);
  for (const date of ['2024-11-05', '2024-11-10']) A.saveOperation(state, { kind: 'session', serviceId: service.id, date, place: 'Улица', currency: 'RSD', amount: 400000, note: '' });
  A.saveOperation(state, { kind: 'expense', category: 'Оплата тренеру', date: '2024-11-11', currency: 'RSD', amount: 600000, quantity: 3, rate: 200000, note: '' });
  assert.deepEqual(A.serviceBalance(state, service.id, '2024-11-11'), { received: 4000000, used: 800000, balance: 3200000 });
  const summary = A.summarize(state, '2024-11');
  assert.deepEqual(summary.receipts, { RSD: 4000000 });
  assert.deepEqual(summary.sessions, { RSD: 800000 });
  assert.deepEqual(summary.localBalance, { RSD: 3400000 });
});

test('a paid session is atomic and creates one receipt for the editable amount', async () => {
  const state = emptyState();
  const client = createClient(state, { name:'Клиент' }, '2024-10-01');
  const service = enrollment(state, client, { kind:'personal', block:'personal', day:null, reminder:false, place:'Зал', rate:400000 });
  const values = { serviceId:service.id, date:'2024-11-11', place:'Зал', currency:'RSD', amount:400000, note:'' };
  assert.throws(() => A.savePaidSession(state, values, 0), /сумму/);
  assert.equal(A.operations(state).length, 0);
  beginCloudSync(state, '10000000-0000-4000-8000-000000000001');
  const store = await createStore({ load:async () => JSON.stringify(state), save:async () => {} });
  const [session, receipt] = await store.mutate(next => A.savePaidSession(next, values, 300000));
  assert.equal(receipt.sessionId, session.id);
  assert.deepEqual(A.summarize(store.state(), '2024-11').receipts, { RSD:300000 });
  assert.deepEqual(A.serviceBalance(store.state(), service.id), { received:300000, used:400000, balance:-100000 });
  assert.deepEqual(Object.keys(store.state().cloudSync.pending).filter(key => key.startsWith('operations/')).sort(),
    [receipt, session].map(item => 'operations/' + item.id).sort());
});

test('legacy backups open, accounting survives restore, and merge does not duplicate a payment', async () => {
  const legacy = emptyState();
  const client = createClient(legacy, { name: 'Клиент' }, '2024-10-01');
  createTask(legacy, client.id, 'Проверить план');
  legacy.settings.drafts = { [client.id]: { text: 'Черновик' } };
  let stored = JSON.stringify(legacy);
  const adapter = { load: async () => stored, save: async value => { stored = value; } };
  let store = await createStore(adapter);
  await store.mutate(state => {
    const service = enrollment(state, client);
    payment(state, '2024-10-24', 'RSD', 800000, [credit(service, '2024-10', 800000)]);
  });
  store = await createStore(adapter);
  const restored = parseImport(exportState(store.state()));
  assert.equal(A.operations(mergeState(restored, restored)).length, 1);
  assert.equal(Object.keys(restored.tasks).length, 1);
  assert.equal(restored.settings.drafts[client.id].text, 'Черновик');
  await store.replace(legacy);
  assert.equal(A.operations(store.state()).length, 0);
  assert.equal(Object.keys(store.state().clients).length, 1);
});

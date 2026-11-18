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

test('personal history distinguishes advance usage, unpaid sessions, and cash receipts', () => {
  const s=emptyState(), client=createClient(s,{name:'Тестовый клиент'},'2026-09-15');
  const tariff=enrollment(s,client,{kind:'personal',block:'personal',place:'Улица',day:null,rate:400000,reminder:false,startsOn:'2026-09-15'});
  const values={serviceId:tariff.id,amount:400000,currency:'RSD',place:'Улица',note:''};
  A.savePaidSession(s,{...values,date:'2026-09-15'},400000);
  const unpaid = ['2026-09-22','2026-09-24'].map(date=>A.saveOperation(s,{...values,date,kind:'session'}));
  const receipt=payment(s,'2026-09-25','RSD',4000000,[credit(tariff,null,4000000)]);
  const paidFromAdvance = A.saveOperation(s,{...values,date:'2026-09-29',kind:'session'});
  const details = A.personalOperationHistory(s,client.id);
  for (const visit of unpaid) assert.deepEqual(details.get(visit.id),{fromAdvance:0,due:400000,currency:'RSD'});
  assert.deepEqual(details.get(receipt.id),{covered:800000,advance:3200000,currency:'RSD'});
  assert.deepEqual(details.get(paidFromAdvance.id),{fromAdvance:400000,due:0,currency:'RSD'});
});

test('a reconciled imported session appears once in history and in monthly counts after reimport', () => {
  const state = emptyState(), client = createClient(state,{name:'Клиент'},'2026-11-06');
  const tariff = enrollment(state,client,{kind:'personal',block:'personal',rate:400000,day:null,place:'Зал',reminder:false,startsOn:'2026-11-06'});
  const row = {id:'ledger-gym',kind:'session',month:'2026-11',date:'',owners:[client.id],block:'personal',
    detail:'1 зан. × 4000 RSD · ноя: 6',values:{RSD:400000}};
  state.ledger = {rows:[row]};
  const visit = {place:'Зал',currency:'RSD',amount:400000,serviceId:tariff.id,note:''};
  const [reconciled] = A.savePaidSession(state,{...visit,date:'2026-11-06',sourceLedgerRowId:row.id},400000);
  A.savePaidSession(state,{...visit,date:'2026-11-13'},400000);
  A.saveOperation(state,{...visit,kind:'session',date:reconciled.date,note:'Уточнено'},reconciled.id);
  assert.equal(A.accounting(state).operations[reconciled.id].sourceLedgerRowId,row.id);
  const history = A.filterClientAccountHistory(state,A.clientAccountHistory(state,client.id),client.id,'personal-gym');
  assert.equal(history.length,4);
  assert.ok(history.every(item=>item.type === 'operation'));
  const summary = A.combinedSummary(state,'2026-11');
  assert.equal(summary.count,2);
  assert.deepEqual(summary.sessions,{RSD:800000});
  assert.deepEqual(summary.receipts,{RSD:800000});
  assert.equal(A.serviceBalance(state,tariff.id).balance,0);
  row.detail = '2 зан. × 2000 RSD';
  assert.equal(A.combinedSummary(state,'2026-11').count,4);
});

test('a one-off visit leaves a payable balance without creating a recurring tariff', () => {
  const state=emptyState(), client=createClient(state,{name:'Тестовый клиент'},'2024-10-01');
  const [session]=A.savePersonalVisit(state,{clientId:client.id,oneOff:true,place:'Зал',currency:'RSD',rate:400000,date:'2024-10-10'});
  const [service]=A.clientServices(state,client.id);
  assert.equal(service.oneOff,true);
  assert.equal(service.endsOn,session.date);
  assert.equal(A.serviceBalance(state,service.id).balance,-400000);
  assert.deepEqual([...A.matchingTariffClients(state,{packageFilter:'personal',tariffCurrency:'all',paymentCurrency:'all'},session.date)],[]);
  payment(state,'2024-10-11','RSD',400000,[credit(service,null,400000)]);
  assert.equal(A.serviceBalance(state,service.id).balance,0);
  assert.doesNotThrow(()=>parseImport(exportState(state)));
});

test('receivables apply linked receipts to their own sessions and general payments to the oldest open balance', () => {
  const state=emptyState();
  const client=createClient(state,{name:'Клиент'},'2024-10-01');
  const service=enrollment(state,client,{kind:'personal',block:'personal',place:'Зал',day:null,reminder:false,
    rate:400000,openingCredit:{date:'2024-10-01',amount:100000},endsOn:'2024-10-15'});
  const values={serviceId:service.id,place:'Зал',currency:'RSD',amount:400000,note:''};
  const pending=A.saveOperation(state,{...values,kind:'session',date:'2024-10-04'});
  A.savePaidSession(state,{...values,date:'2024-10-08'},400000);
  payment(state,'2024-10-09','RSD',50000,[credit(service,null,50000)]);
  const [balance]=A.personalReceivables(state,'2024-10-17');
  assert.deepEqual(balance.unpaid,[{session:pending,remaining:250000}]);
  assert.equal(balance.remaining,-A.serviceBalance(state,service.id,'2024-10-17').balance);
  payment(state,'2024-10-17','RSD',250000,[credit(service,null,250000)]);
  assert.deepEqual(A.personalReceivables(state,'2024-10-17'),[]);
});

test('assistant commits a new tariff and dated operations together', () => {
  const state=emptyState(), client=createClient(state,{name:'Тестовый клиент'},'2024-10-01');
  const visit={clientId:client.id,oneOff:false,place:'Зал',currency:'RSD',rate:400000,date:'2024-10-10'};
  assert.throws(()=>A.savePersonalVisit(state,{...visit,payment:{amount:0,date:'2024-10-12'}}));
  assert.equal(A.clientServices(state,client.id).length,0);
  assert.equal(A.operations(state).length,0);
  const [session, receipt]=A.savePersonalVisit(state,{...visit,payment:{amount:400000,date:'2024-10-12'}});
  assert.equal(A.clientServices(state,client.id)[0].endsOn,null);
  assert.equal(session.date,'2024-10-10');
  assert.equal(receipt.date,'2024-10-12');
  assert.equal(receipt.sessionId,session.id);
  assert.throws(()=>A.savePersonalVisit(state,visit),/уже есть тариф/);
  assert.equal(A.operations(state).length,2);
});

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

test('late receipts close their selected month, and past due balances stay visible across the month boundary', () => {
  const state = emptyState();
  const client = createClient(state,{name:'Клиент'},'2025-10-01');
  const group = enrollment(state,client,{startsOn:'2025-10-01',day:17,billingFrom:'2025-10'});
  const personal = enrollment(state,client,{startsOn:'2025-10-01',kind:'personal',block:'personal',
    day:null,reminder:false,place:'Зал',rate:400000});
  payment(state,'2025-11-03','RSD',800000,[credit(group,'2025-10',800000)]);
  payment(state,'2025-11-04','RSD',400000,[credit(personal,null,400000)]);
  const status = date => A.currentPaymentStatuses(state,date).get(group.id);
  assert.equal(status('2025-11-17').timing,'today');
  assert.equal(status('2025-11-20').timing,'grace');
  assert.equal(A.clientPaymentStatuses(state,'2025-11-21').get(client.id),'overdue');
  const november = payment(state,'2025-11-24','RSD',300000,[credit(group,'2025-11',300000)]);
  payment(state,'2025-11-27','RSD',800000,[credit(group,'2025-12',800000)]);
  assert.equal(status('2025-12-01').type,'paid');
  assert.deepEqual(status('2025-12-01').previous,{month:'2025-11',due:'2025-11-17',remaining:500000,timing:'overdue'});
  assert.equal(A.clientPaymentStatuses(state,'2025-12-01').get(client.id),'overdue');
  payment(state,'2025-12-02','RSD',500000,[credit(group,'2025-11',500000)]);
  assert.equal(A.clientPaymentStatuses(state,'2025-12-02').get(client.id),'paid');
  A.setVoided(state,november.id,true);
  assert.equal(status('2025-12-02').previous.remaining,300000);
});

test('confirmed archive payments and explicit early allocations show coverage without assuming earlier debts', () => {
  const state = emptyState();
  const client = createClient(state,{name:'Клиент'},'2025-11-01');
  const group = enrollment(state,client,{startsOn:'2025-11-12',day:17,billingFrom:'2025-12'});
  const date = '2025-11-17';
  const status = () => A.currentPaymentStatuses(state,date).get(group.id);
  const archive = { owners:[client.id],block:'belgrade',date:'2025-11-07',month:'2025-11',values:{RSD:800000} };
  state.ledger = {rows:[{...archive,kind:'review'}]};
  assert.equal(status().type,'none');
  assert.equal(status().nextDue,'2025-12-17');
  state.ledger.rows[0].kind = 'payment';
  assert.equal(status().type,'paid');
  assert.equal(status().lastPaidOn,'2025-11-07');
  const receipt = payment(state,archive.date,'RSD',800000,[credit(group,'2025-12',800000)]);
  assert.equal(status().type,'none');
  assert.equal(status().nextDue,'2026-01-17');
  A.saveOperation(state,{...receipt,allocations:[credit(group,'2025-11',800000)]},receipt.id);
  assert.equal(status().type,'paid');
  assert.equal(status().nextDue,'2025-12-17');
});

test('an agreed receipt in another currency settles a month or a range without counting a second receipt', () => {
  const state = emptyState();
  const client = createClient(state,{name:'Клиент'},'2024-10-01');
  const group = enrollment(state,client,{startsOn:'2024-11-12',billingFrom:'2024-12'});
  const settle = (firstMonth,lastMonth,part,replacedId) => A.settleMonths(state,{serviceId:group.id,firstMonth,lastMonth,part},replacedId,'2024-11-17');
  const november = payment(state,'2024-11-01','RUB',800000,settle('2024-11',undefined,800000));
  assert.equal(A.monthlyCharge(state,group,'2024-11','2024-11-17').remaining,0);
  assert.deepEqual(A.summarize(state,'2024-11').receipts,{RUB:800000});
  assert.throws(()=>settle('2024-11',undefined,800000),/уже оплачен/);
  assert.deepEqual(settle('2024-11',undefined,800000,november.id),november.allocations);
  payment(state,'2024-11-10','RSD',200000,[credit(group,'2024-12',200000)]);
  const rest = settle('2024-11','2025-02',2300001);
  assert.deepEqual(rest.map(item=>[item.month,item.credit]),[['2024-12',600000],['2025-01',800000],['2025-02',800000]]);
  assert.equal(rest.reduce((total,item)=>total+item.part,0),2300001);
  payment(state,'2024-11-17','RUB',2300001,rest);
  assert.deepEqual(A.summarize(state,'2024-11').receipts,{RUB:3100001,RSD:200000});
  assert.deepEqual(A.summarize(state,'2024-12').receipts,{});
  assert.equal(A.currentPaymentStatuses(state,'2024-11-17').get(group.id).nextDue,'2025-03-24');
});

test('client history merges old receipts with actual operations and replaces an undated coverage marker', () => {
  const state = emptyState();
  const client = createClient(state,{name:'Клиент'},'2024-10-01');
  const group = enrollment(state,client,{startsOn:'2024-11-12',billingFrom:'2024-12',coveredThrough:'2024-11'});
  const october = { kind:'payment',block:'belgrade',owners:[client.id],date:'2024-10-03',month:'2024-10',values:{RSD:800000} };
  state.ledger = {rows:[october,{...october,kind:'repeat'},
    {...october,kind:'review',date:'2024-11-04',month:'2024-11'}]};
  const day = '2024-11-17';
  const history = () => A.clientAccountHistory(state,client.id,day);
  assert.deepEqual(history().map(item=>item.type),['coverage','ledger']);
  assert.equal(history()[1].row.date,'2024-10-03');
  assert.equal(A.monthlyCharge(state,group,'2024-11',day).coverageOnly,true);
  assert.deepEqual(A.combinedSummary(state,'2024-11').receipts,{});
  const values = {serviceId:group.id,firstMonth:'2024-11',part:800000,recordCovered:true};
  const allocations = A.settleMonths(state,values,undefined,day);
  const november = payment(state,'2024-11-01','RUB',800000,allocations);
  assert.deepEqual(history().map(item=>item.type),['operation','ledger']);
  assert.equal(history()[0].operation.id,november.id);
  assert.deepEqual(A.combinedSummary(state,'2024-11').receipts,{RUB:800000});
  assert.throws(()=>A.settleMonths(state,values,undefined,day),/уже записана полная оплата/);
  state.ledger.rows.push({...october,date:'2024-11-01',month:'2024-11',values:{RUB:800000}});
  assert.equal(history().length,2);
  A.setVoided(state,november.id,true);
  assert.deepEqual(history().map(item=>item.type),['coverage','operation','ledger','ledger']);
});

test('history keeps the group, gym and outdoor tariffs distinct, including split archive receipts', () => {
  const state=emptyState();
  const client=createClient(state,{name:'Клиент'},'2024-10-01');
  const group=enrollment(state,client);
  const personal=enrollment(state,client,{kind:'personal',block:'personal',place:'Зал',day:null,reminder:false,rate:400000});
  const [session,paid]=A.savePaidSession(state,{serviceId:personal.id,place:'Зал',currency:'RSD',amount:400000,date:'2024-10-08',note:''},400000);
  const mixed=payment(state,'2024-10-09','RSD',1200000,[credit(group,'2024-10',800000),credit(personal,null,400000)]);
  const archive={kind:'payment',block:'belgrade',date:'2024-10-03',month:'2024-10',owners:[client.id],values:{RSD:1200000},
    packageParts:{RSD:{belgrade:800000,personal:400000}}};
  state.ledger={rows:[archive]};
  const history=A.clientAccountHistory(state,client.id,'2024-10-17');
  const filtered=tariff=>A.filterClientAccountHistory(state,history,client.id,tariff).map(item=>item.operation ?? item.row.values);
  const gymHistory=filtered('personal-gym');
  assert.deepEqual(new Set(gymHistory.filter(item=>item.kind)),new Set([mixed,paid,session]));
  assert.deepEqual(gymHistory.filter(item=>item.RSD),[{RSD:400000}]);
  assert.deepEqual(filtered('belgrade'),[mixed,{RSD:800000}]);
  const outdoor=enrollment(state,client,{kind:'personal',block:'personal',place:'Улица',day:null,reminder:false,rate:400000});
  assert.deepEqual([A.tariffLabel(group),A.tariffLabel(personal),A.tariffLabel(outdoor)],['Группа','Зал','Улица']);
  assert.deepEqual(filtered('personal-outside'),[]);
  assert.equal(filtered('personal-gym').filter(item=>item.RSD).length,0);
});

test('history exposes imported visits without an assigned tariff and omits tariffs without records', () => {
  const state = emptyState(), client = createClient(state,{name:'Клиент'},'2026-08-01');
  const group = enrollment(state,client,{startsOn:'2026-08-01'});
  enrollment(state,client,{kind:'personal',block:'personal',place:'Улица',day:null,reminder:false,rate:400000});
  const receipt = payment(state,'2026-08-01','RSD',800000,[credit(group,'2026-08',800000)]);
  state.ledger = {rows:[{
    id:'ledger-gym-visit',sourceLedgerRowId:'ledger-gym-month',kind:'session',date:'2026-07-22',month:'2026-07',
    owners:[client.id],block:'personal',place:'Зал',values:{RSD:400000}
  }]};
  const history = A.clientAccountHistory(state,client.id,'2026-08-15');
  const byTariff = A.clientHistoryByTariff(state,history,client.id);
  assert.deepEqual([...byTariff.keys()],['belgrade','personal-gym']);
  assert.deepEqual(byTariff.get('belgrade').map(item=>item.operation.id),[receipt.id]);
  assert.deepEqual(byTariff.get('personal-gym').map(item=>item.row.date),['2026-07-22']);
});

test('moving a due day preserves receipts and can apply for one month or from a selected month', () => {
  const state = emptyState();
  const client = createClient(state,{name:'Клиент'},'2024-10-01');
  const service = enrollment(state,client,{startsOn:'2024-11-12',day:28});
  const receipt = payment(state,'2024-11-01','RUB',800000,[credit(service,'2024-11',800000)]);
  const status = () => A.currentPaymentStatuses(state,'2024-11-17').get(service.id);
  assert.equal(status().due,'2024-11-28');
  A.movePaymentDay(state,service.id,'2024-11',1,'once');
  assert.equal(status().due,'2024-11-01');
  assert.equal(status().nextDue,'2024-12-28');
  A.movePaymentDay(state,service.id,'2024-12',3,'from');
  assert.equal(status().nextDue,'2024-12-03');
  assert.equal(A.paymentReminders(state,'2024-12-02')[0].due,'2024-12-03');
  const restored = parseImport(exportState(state));
  const saved = A.accounting(restored).services[service.id];
  assert.equal(A.monthlyCharge(restored,saved,'2025-01','2024-11-17').due,'2025-01-03');
  assert.deepEqual(A.accounting(restored).operations[receipt.id],receipt);
  assert.throws(()=>A.movePaymentDay(state,service.id,'2024-10',1,'once'),/месяц действия тарифа/);
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

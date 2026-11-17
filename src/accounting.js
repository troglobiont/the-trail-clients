import { addDays, id, localDate, validDate } from './model-utils.js';

export const SERVICES = {
  belgrade: 'Группа Белграда', online: 'Онлайн-ведение',
  coaching: 'Премиум онлайн', personal: 'Персональная тренировка'
};
export const PACKAGES = { ...SERVICES, gym:'План Gym', trainingpeaks:'TrainingPeaks' };
export const packageKind = key => key === 'gym' || key === 'trainingpeaks' ? 'coaching' : key;
export const servicePackage = service => service.package || service.kind;
export const TARIFF_LABELS = { belgrade:'Группа', 'personal-gym':'Зал', 'personal-outside':'Улица',
  online:'Онлайн', coaching:'Премиум', gym:'План Gym', trainingpeaks:'TrainingPeaks' };
export const tariffKey = service => service.kind === 'personal' ? service.place === 'Зал' ? 'personal-gym' : 'personal-outside' : servicePackage(service);
export const tariffLabel = service => TARIFF_LABELS[tariffKey(service)];
export const BLOCKS = { belgrade: 'Белград', online: 'Онлайн', personal: 'Персональные' };
export const CURRENCIES = ['RSD', 'RUB', 'EUR', 'USD'];
export const PLACES = ['Зал', 'Улица'];
export const EXPENSES = ['Оплата тренеру', 'Налоги', 'Реклама', 'Прочее'];
export const MOVEMENT = { new: 'Новые', returned: 'Вернулись', paused: 'На паузе', ended: 'Завершили' };
export const DEFAULT_REMINDERS = { belgrade: 3, online: 0, personal: 0 };
const PAYMENT_GRACE_DAYS = 3;
const EMPTY = { services: {}, operations: {}, reminders: {} };
const MAX_AMOUNT = 100000000000;
const validMoney = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT;
const validKey = key => typeof key === 'string' && /^[-a-zA-Z0-9_]{1,180}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validNote = value => typeof value === 'string' && value.length <= 300;
const validReminder = days => Number.isInteger(days) && days >= 0 && days <= 30;
const validPaymentDay = day => Number.isInteger(day) && day >= 1 && day <= 31;
const validMonth = value => typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && validDate(value + '-01');
const objectMap = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 50000;

export function amountMinor(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw Error('Укажи сумму с точностью до двух знаков');
  const [units, decimals = ''] = normalized.split('.');
  const result = Number(units) * 100 + Number(decimals.padEnd(2, '0'));
  if (!validMoney(result)) throw Error('Проверь сумму');
  return result;
}

export function money(value, currency) {
  const units = (value / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const symbols = { RUB: '₽', EUR: '€', USD: '$', RSD: 'RSD' };
  return `${units}\u00a0${symbols[currency]}`;
}

export const accounting = state => state.accounting ?? EMPTY;
function writable(state) {
  return state.accounting ??= { services: {}, operations: {}, reminders: {} };
}

function checkService(state, service) {
  const { clientId, kind, block, startsOn, endsOn, currency, rate, day, reminder, place } = service;
  if (!validKey(clientId) || !has(state.clients, clientId) || !has(SERVICES, kind) || !has(BLOCKS, block)) throw Error('Выбери клиента, услугу и раздел учёта');
  if (!validDate(startsOn) || (endsOn !== null && (!validDate(endsOn) || endsOn < startsOn))) throw Error('Проверь период действия услуги');
  if (!CURRENCIES.includes(currency) || !validMoney(rate)) throw Error('Проверь тариф и валюту');
  const key = servicePackage(service);
  if (!has(PACKAGES, key) || packageKind(key) !== kind) throw Error('Проверь пакет');
  if (kind === 'personal') {
    if (day !== null || reminder !== false || !PLACES.includes(place)) throw Error('Выбери место занятия');
    if (service.openingCredit && (!validMoney(service.openingCredit.amount) || !validDate(service.openingCredit.date))) throw Error('Проверь остаток аванса');
  } else if (!validPaymentDay(day) || typeof reminder !== 'boolean' || place !== null) {
    throw Error('Укажи день оплаты от 1 до 31');
  } else if ([service.billingFrom, service.coveredThrough].some(month => month != null && !validMonth(month))) {
    throw Error('Проверь месяц начисления или предоплаты');
  }
  if (service.paymentDays !== undefined && (kind === 'personal' || !objectMap(service.paymentDays) ||
      Object.entries(service.paymentDays).some(([period,value]) => !validMonth(period) || !objectMap(value) ||
        !Object.keys(value).length || Object.entries(value).some(([key,day]) => !['once','from'].includes(key) || !validPaymentDay(day))))) {
    throw Error('Проверь график оплаты');
  }
}

export function saveService(state, values, serviceId = id('service')) {
  const book = accounting(state);
  const before = book.services[serviceId];
  const service = { ...values, id: serviceId };
  checkService(state, service);
  if (!validKey(serviceId) || state.clients[service.clientId].role !== 'Клиент') throw Error('Услуги доступны в карточке клиента');
  if (before) {
    const history = Object.values(book.operations).filter(o => linked(o, serviceId));
    if (history.length && (servicePackage(before) !== servicePackage(service)
      || ['kind', 'clientId', 'currency', 'block'].some(key => before[key] !== service[key]))) {
      throw Error('У услуги есть операции. Для нового вида, раздела или валюты добавь отдельную услугу');
    }
    if (history.length && before.kind !== 'personal' && ['startsOn', 'rate', 'day'].some(key => before[key] !== service[key])) {
      throw Error('Для новых условий заверши текущую услугу и добавь новую с нужной даты');
    }
  }
  writable(state).services[serviceId] = service;
  return service;
}

function checkOperation(book, operation) {
  const { kind, date, currency, amount, note, voided } = operation;
  if (!validDate(date) || !CURRENCIES.includes(currency) || !validMoney(amount) || !validNote(note) || typeof voided !== 'boolean') throw Error('Проверь дату, валюту и сумму операции');
  if (kind === 'payment') {
    const { payer, allocations } = operation;
    if (operation.sessionId !== undefined && !validKey(operation.sessionId)) throw Error('Некорректная связь с занятием');
    if (!validNote(payer) || !Array.isArray(allocations) || !allocations.length || allocations.length > 120) throw Error('Укажи, что покрывает оплата');
    let allocated = 0;
    const targets = new Set();
    for (const allocation of allocations) {
      const { serviceId, month, part, credit } = allocation ?? {};
      const service = has(book.services, serviceId) && book.services[serviceId];
      if (!service || !validMoney(part) || !validMoney(credit) || (currency === service.currency && part !== credit)) throw Error('Проверь распределение оплаты');
      if (service.kind === 'personal' ? month !== null : !validMonth(month)) throw Error('Укажи месяц для каждой месячной услуги');
      const target = `${serviceId}/${month}`;
      if (targets.has(target)) throw Error('Объедини суммы за одну услугу и месяц в одной строке');
      targets.add(target);
      allocated += part;
    }
    if (allocated !== amount) throw Error('Сумма распределения должна совпадать с поступлением');
  } else if (kind === 'session') {
    const service = has(book.services, operation.serviceId) && book.services[operation.serviceId];
    if (service?.kind !== 'personal' || service.currency !== currency || !PLACES.includes(operation.place)) throw Error('Выбери персональную услугу и место занятия');
    if (operation.sourceLedgerRowId !== undefined && !validKey(operation.sourceLedgerRowId)) throw Error('Некорректная связь со строкой учёта');
  } else if (kind === 'expense') {
    if (!EXPENSES.includes(operation.category)) throw Error('Выбери статью расхода');
    if (operation.quantity !== null && (operation.category !== 'Оплата тренеру' || !Number.isInteger(operation.quantity) || operation.quantity < 1 || !validMoney(operation.rate) || operation.quantity * operation.rate !== amount)) throw Error('Проверь число занятий и ставку тренера');
    if (operation.quantity === null && operation.rate !== null) throw Error('Укажи число занятий для расчёта по ставке');
  } else throw Error('Неизвестный вид операции');
}

export function validateAccounting(state) {
  if (state.accounting === undefined) return;
  const book = state.accounting;
  if (!book || !objectMap(book.services) || !objectMap(book.operations) || !objectMap(book.reminders)) throw Error('Некорректные данные учёта');
  for (const [key, value] of Object.entries(book.reminders)) {
    if (!has(BLOCKS, key) || !validReminder(value)) throw Error('Некорректные настройки напоминаний');
  }
  for (const [key, service] of Object.entries(book.services)) {
    if (!validKey(key) || !service || key !== service.id) throw Error('Некорректная услуга');
    checkService(state, service);
  }
  for (const [key, operation] of Object.entries(book.operations)) {
    if (!validKey(key) || !operation || key !== operation.id) throw Error('Некорректная операция');
    checkOperation(book, operation);
  }
}

function prepareOperation(state, values, operationId) {
  const book = accounting(state);
  const prior = book.operations[operationId];
  if (!validKey(operationId) || (prior && prior.kind !== values.kind)) throw Error('Некорректная операция');
  const operation = { ...values, id: operationId, voided: prior?.voided ?? false };
  if (prior?.sourceLedgerRowId && operation.kind === 'session') operation.sourceLedgerRowId ??= prior.sourceLedgerRowId;
  checkOperation(book, operation);
  if (operation.date > localDate()) throw Error('Укажи дату фактической операции');
  if (operation.kind === 'session' && (prior?.serviceId !== operation.serviceId || prior?.date !== operation.date)) {
    const service = book.services[operation.serviceId];
    if (service.oneOff ? Object.values(book.operations).some(o=>o.kind==='session' && o.serviceId===service.id && o.id!==operationId)
      : !activeService(service,operation.date)) throw Error(service.oneOff ? 'Разовое занятие уже записано' : 'На эту дату услуга не действовала');
  }
  return operation;
}

export function saveOperation(state, values, operationId = id('operation')) {
  const operation = prepareOperation(state, values, operationId);
  writable(state).operations[operationId] = operation;
  return operation;
}

export function savePaidSession(state, values, received, paymentDate = values.date, ids = {}) {
  const session = prepareOperation(state, { ...values, kind: 'session' }, ids.session ?? id('operation'));
  const payment = prepareOperation(state, {
    kind: 'payment', date: paymentDate, amount: received, currency: session.currency, note: '', payer: '',
    sessionId: session.id, allocations: [{ serviceId: session.serviceId, month: null, part: received, credit: received }]
  }, ids.payment ?? id('operation'));
  Object.assign(writable(state).operations, { [session.id]: session, [payment.id]: payment });
  return [session, payment];
}

export function hasManualSession(state, serviceId, date) {
  return Object.values(accounting(state).operations).some(operation => operation.kind === 'session' && !operation.voided
    && operation.serviceId === serviceId && operation.date === date && !operation.id.startsWith('calendar-session-'));
}

export function recordCalendarSession(state, { clientId, serviceId, date, currency, amount, place, sessionId, paymentId, received, receivedOn, separate }) {
  const book = accounting(state);
  const service = book.services[serviceId];
  if (service?.clientId !== clientId || service.kind !== 'personal' || service.oneOff || !activeService(service,date)
      || service.rate !== amount || service.currency !== currency || service.place !== place) {
    throw Error('Тариф изменился. Открой тренировку заново');
  }
  if (book.operations[sessionId] && !book.operations[sessionId].voided) throw Error('Эта тренировка уже записана');
  if (book.operations[paymentId] && !book.operations[paymentId].voided) {
    throw Error('За эту тренировку уже есть оплата. Проверь историю занятий');
  }
  if (!separate && hasManualSession(state,serviceId,date)) throw Error('На эту дату уже есть занятие. Подтверди, что записываешь другое');
  const values = { serviceId, date, currency, amount, place, note:'' };
  const saved = received
    ? savePaidSession(state,values,received,receivedOn,{session:sessionId,payment:paymentId})
    : [saveOperation(state,{...values,kind:'session'},sessionId)];
  for (const operation of saved) operation.voided = false;
  return saved;
}

export function savePersonalVisit(state, { clientId, serviceId, oneOff, place, currency, rate, date, payment, paymentOnly = false }) {
  const book = accounting(state);
  const draft = { ...state, accounting:{ ...book, services:{ ...book.services }, operations:{ ...book.operations } } };
  const client = state.clients[clientId];
  if (!client || client.role !== 'Клиент' || client.mergedInto) throw Error('Выбери действующую карточку клиента');
  let service = book.services[serviceId];
  if (serviceId) {
    if (service?.clientId !== clientId || service.kind !== 'personal' || service.currency !== currency) {
      throw Error('Условия услуги изменились. Выбери тариф заново');
    }
  } else {
    if (!oneOff && clientServices(state, clientId).some(s=>s.kind === 'personal' && !s.oneOff
        && s.place === place && (!s.endsOn || s.endsOn >= date))) {
      throw Error('На эту дату уже есть тариф для этого места. Выбери его из списка');
    }
    service = saveService(draft, { clientId, kind:'personal', package:'personal', block:'personal', startsOn:date,
      endsOn:oneOff ? date : null, ...(oneOff ? { oneOff:true } : {}), currency, rate, day:null, reminder:false, place });
  }
  const values = { serviceId:service.id, date, place, currency, amount:rate, note:'' };
  if (paymentOnly && (!payment || oneOff)) throw Error('Укажи полученную оплату');
  const operations = paymentOnly ? [saveOperation(draft,{kind:'payment', date:payment.date, currency, amount:payment.amount, payer:'', note:'',
    allocations:[{serviceId:service.id, month:null, part:payment.amount, credit:payment.amount}]})]
    : payment ? savePaidSession(draft,values,payment.amount,payment.date) : [saveOperation(draft,{ ...values, kind:'session' })];
  state.accounting = draft.accounting;
  return operations;
}

export function setVoided(state, operationId, voided) {
  const operation = accounting(state).operations[operationId];
  if (!operation) throw Error('Операция не найдена');
  operation.voided = voided;
}

export function saveReminders(state, values) {
  if (Object.keys(values).some(key => !has(BLOCKS, key) || !validReminder(values[key]))) throw Error('Укажи от 0 до 30 дней');
  writable(state).reminders = { ...values };
}

export function mergeAccounting(target, incoming) {
  if (!incoming.accounting) return;
  const existing = accounting(target);
  const copied = JSON.parse(JSON.stringify(incoming.accounting));
  target.accounting = {
    services: { ...copied.services, ...existing.services },
    operations: { ...copied.operations, ...existing.operations },
    reminders: { ...copied.reminders, ...existing.reminders }
  };
}

export const linked = (operation, serviceId) => operation.kind === 'payment'
  ? operation.allocations.some(item => item.serviceId === serviceId) : operation.serviceId === serviceId;

export function clientServices(state, clientId) {
  return Object.values(accounting(state).services).filter(s => s.clientId === clientId);
}

export function activeService(service, date) {
  return service.startsOn <= date && (!service.endsOn || service.endsOn >= date);
}

export function matchingTariffClients(state, { packageFilter, tariffCurrency, paymentCurrency, paymentMonth }, today = localDate()) {
  const { services } = accounting(state);
  const matchesPackage = s => {
    const key = servicePackage(s);
    if (packageFilter === 'all') return true;
    if (packageFilter === 'all-online') return ['online', 'coaching'].includes(key);
    return key === packageFilter || tariffKey(s) === packageFilter;
  };
  const tariffs = packageFilter !== 'all' || tariffCurrency !== 'all'
    ? new Set(Object.values(services).filter(s => !s.oneOff && activeService(s, today) && matchesPackage(s)
      && (tariffCurrency === 'all' || s.currency === tariffCurrency)).map(s => s.clientId)) : null;
  if (paymentCurrency === 'all') return tariffs;

  const paid = new Set();
  for (const o of operations(state, { month:paymentMonth })) {
    if (o.kind !== 'payment' || o.currency !== paymentCurrency) continue;
    for (const item of o.allocations) paid.add(services[item.serviceId].clientId);
  }
  for (const entry of state.ledger?.rows || []) {
    if (['payment','shared'].includes(entry.kind) && entry.date.startsWith(paymentMonth + '-') && entry.values[paymentCurrency] > 0) {
      for (const owner of entry.owners) paid.add(owner);
    }
  }
  return tariffs ? new Set([...tariffs].filter(id => paid.has(id))) : paid;
}

export function operations(state, { month, clientId, includeVoided = false } = {}) {
  const services = clientId ? clientServices(state, clientId) : [];
  return Object.values(accounting(state).operations).filter(o => (includeVoided || !o.voided)
    && (!month || o.date.startsWith(month + '-')) && (!clientId || services.some(s => linked(o, s.id))))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export function serviceBalance(state, serviceId, today = localDate()) {
  let received = 0;
  let used = 0;
  for (const o of operations(state)) {
    if (o.date > today) continue;
    if (o.kind === 'session' && o.serviceId === serviceId) used += o.amount;
    if (o.kind === 'payment') for (const item of o.allocations) if (item.serviceId === serviceId) received += item.credit;
  }
  const opening = accounting(state).services[serviceId]?.openingCredit;
  const credit = opening && opening.date <= today ? opening.amount : 0;
  return { received, used, balance: credit + received - used };
}

export function personalBalances(state, through = localDate()) {
  const result = { advance:{}, debt:{} };
  for (const service of Object.values(accounting(state).services)) {
    if (service.kind !== 'personal') continue;
    const { balance } = serviceBalance(state,service.id,through);
    if (balance) addTotal(balance > 0 ? result.advance : result.debt,service.currency,Math.abs(balance));
  }
  return result;
}

export function personalReceivables(state, through = localDate(), clientId) {
  const accounts = new Map();
  for (const service of Object.values(accounting(state).services)) {
    if (service.kind !== 'personal' || (clientId && service.clientId !== clientId)) continue;
    const advance = service.openingCredit;
    accounts.set(service.id,{ service, sessions:[], targeted:new Map(), credit:advance?.date <= through ? advance.amount : 0 });
  }
  for (const operation of operations(state)) {
    if (operation.date > through) continue;
    if (operation.kind === 'session') accounts.get(operation.serviceId)?.sessions.push(operation);
    if (operation.kind !== 'payment') continue;
    for (const allocation of operation.allocations) {
      const account = accounts.get(allocation.serviceId);
      if (!account) continue;
      account.credit += allocation.credit;
      if (operation.sessionId) account.targeted.set(operation.sessionId,(account.targeted.get(operation.sessionId) ?? 0) + allocation.credit);
    }
  }
  const result = [];
  for (const {service,sessions,targeted,credit} of accounts.values()) {
    let available = credit;
    const open = sessions.sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map(session => {
      const covered = Math.min(session.amount,targeted.get(session.id) ?? 0);
      available -= covered;
      return { session, remaining:session.amount - covered };
    });
    const unpaid = open.filter(item => {
      const covered = Math.min(item.remaining,available);
      available -= covered;
      item.remaining -= covered;
      return item.remaining > 0;
    });
    if (unpaid.length) result.push({service,unpaid,remaining:unpaid.reduce((sum,item) => sum + item.remaining,0)});
  }
  return result.sort((a,b) => a.unpaid[0].session.date.localeCompare(b.unpaid[0].session.date));
}

function addTotal(totals, currency, amount) {
  totals[currency] = (totals[currency] ?? 0) + amount;
}

export function summarize(state, month) {
  const book = accounting(state);
  const result = { receipts: {}, expenses: {}, localBalance: {}, blocks: {}, services: {}, sessions: {}, count: 0 };
  for (const operation of operations(state, { month })) {
    const { kind, amount, currency } = operation;
    if (kind === 'payment') {
      addTotal(result.receipts, currency, amount);
      for (const item of operation.allocations) {
        const service = book.services[item.serviceId];
        addTotal(result.blocks[service.block] ??= {}, currency, item.part);
        addTotal(result.services[servicePackage(service)] ??= {}, currency, item.part);
        if (service.block !== 'online') addTotal(result.localBalance, currency, item.part);
      }
    } else if (kind === 'expense') {
      addTotal(result.expenses, currency, amount);
      addTotal(result.localBalance, currency, -amount);
    } else {
      addTotal(result.sessions, currency, amount);
      result.count++;
    }
  }
  return result;
}

function receiptKey(owners,date,currency,amount) {
  return date && owners.length ? JSON.stringify([[...new Set(owners)].sort(),date,currency,amount]) : null;
}

const operationReceiptKey = (services, operation) => receiptKey(
  operation.allocations.map(item => services[item.serviceId].clientId),
  operation.date,operation.currency,operation.amount);

function reconciledSessionRows(state, operations, rows) {
  const services = accounting(state).services;
  const sources = new Map(operations.filter(o => o.kind === 'session' && !o.voided && o.sourceLedgerRowId)
    .map(o => [o.sourceLedgerRowId,o]));
  return new Set(rows.filter(row => {
    const session = sources.get(row.id);
    return row.kind === 'session' && /^1 зан\./.test(row.detail) && session
      && row.owners.length === 1 && row.owners[0] === services[session.serviceId].clientId
      && (!row.date || row.date === session.date) && session.date.slice(0,7) === row.month && row.values[session.currency] === session.amount
      && Object.entries(row.values).every(([currency,value])=>currency===session.currency || !value);
  }).map(row=>row.id));
}

export function combinedSummary(state, month) {
  const result = summarize(state,month), book = accounting(state);
  result.imported = { receipts:0, expenses:0, sessionRows:0, skippedDuplicates:0, review:0 };
  const nativeByKey = new Map();
  const historicalServices = new Map();
  const ledgerByKey = new Map();
  const payments = [];
  for (const service of Object.values(book.services)) {
    const services = historicalServices.get(service.clientId) || [];
    services.push(service);
    historicalServices.set(service.clientId,services);
  }
  const recorded = operations(state,{month});
  const imported = state.ledger?.rows || [];
  const reconciled = reconciledSessionRows(state,recorded,imported);
  for (const operation of recorded) {
    if (operation.kind !== 'payment') continue;
    const key = operationReceiptKey(book.services,operation);
    nativeByKey.set(key,(nativeByKey.get(key)||0)+1);
  }
  for (const row of imported) {
    if (row.kind === 'review') {
      if (row.month === month) result.imported.review++;
      continue;
    }
    if (row.kind === 'payment' || row.kind === 'shared') {
      if (!validDate(row.date) || !row.date.startsWith(month+'-')) continue;
      for (const [currency,amount] of Object.entries(row.values)) if (amount > 0) {
        const key = receiptKey(row.owners,row.date,currency,amount);
        if (key) ledgerByKey.set(key,(ledgerByKey.get(key)||0)+1);
        payments.push({row,currency,amount,key});
      }
      continue;
    }
    if (row.month !== month) continue;
    if (row.kind === 'expense') {
      for (const [currency,amount] of Object.entries(row.values)) {
        addTotal(result.expenses,currency,amount);
        addTotal(result.localBalance,currency,-amount);
      }
      result.imported.expenses++;
    } else if (row.kind === 'session') {
      if (reconciled.has(row.id)) {
        result.imported.skippedDuplicates++;
        continue;
      }
      for (const [currency,amount] of Object.entries(row.values)) addTotal(result.sessions,currency,amount);
      const sessions = Number(/^([\d.]+) зан\./.exec(row.detail || '')?.[1]);
      if (Number.isInteger(sessions) && sessions > 0) result.count += sessions;
      result.imported.sessionRows++;
    }
  }
  for (const {row,currency,amount,key} of payments) {
    if (key && nativeByKey.get(key) === 1 && ledgerByKey.get(key) === 1) {
      result.imported.skippedDuplicates++;
      continue;
    }
    const candidates = row.owners.length === 1
      ? (historicalServices.get(row.owners[0])||[]).filter(s=>s.block===row.block&&activeService(s,row.date))
      : [];
    const packageId = Object.hasOwn(PACKAGES,row.package) ? row.package
      : candidates.length===1 ? servicePackage(candidates[0])
      : row.block==='personal' ? 'personal'
      : row.block==='online' ? 'unclassified-online'
      : row.block==='belgrade' ? 'unclassified-belgrade' : 'unclassified';
    addTotal(result.receipts,currency,amount);
    addTotal(result.blocks[row.block]??={},currency,amount);
    const splits = row.packageParts?.[currency];
    if (splits && Object.values(splits).reduce((sum,value)=>sum+value,0)===amount) {
      for (const [service, part] of Object.entries(splits)) addTotal(result.services[service]??={},currency,part);
    } else addTotal(result.services[packageId]??={},currency,amount);
    if (row.block !== 'online') addTotal(result.localBalance,currency,amount);
    result.imported.receipts++;
  }
  return result;
}

export function nextMonth(month, delta = 1) {
  const date = new Date(month + '-01T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

export function paymentDay(service, month) {
  const schedule = service.paymentDays ?? {};
  if (schedule[month]?.once) return schedule[month].once;
  const latest = Object.keys(schedule).filter(period => period <= month && schedule[period].from).sort().pop();
  return latest ? schedule[latest].from : service.day;
}

export function movePaymentDay(state, serviceId, month, day, mode) {
  const service = accounting(state).services[serviceId];
  if (!service || service.kind === 'personal') throw Error('Выбери месячный тариф');
  if (!validMonth(month) || month < service.startsOn.slice(0,7) || (service.endsOn && month > service.endsOn.slice(0,7))) {
    throw Error('Выбери месяц действия тарифа');
  }
  if (!validPaymentDay(day) || !['once','from'].includes(mode)) throw Error('Укажи день оплаты от 1 до 31');
  const paymentDays = { ...service.paymentDays, [month]:{ ...service.paymentDays?.[month], [mode]:day } };
  if (mode === 'from') delete paymentDays[month].once;
  return saveService(state,{...service,paymentDays},serviceId);
}

function dueDate(service, month) {
  const last = new Date(month + '-01T12:00:00Z');
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const day = String(Math.min(paymentDay(service,month), last.getUTCDate())).padStart(2, '0');
  const due = `${month}-${day}`;
  return due < service.startsOn && !service.paymentDays?.[month] ? service.startsOn : due;
}

function monthlyCredits(state, today, replacedId) {
  const book = accounting(state);
  const credits = new Map();
  const receipts = new Set();
  const add = (serviceId, month, amount, date) => {
    const key = `${serviceId}/${month}`;
    const previous = credits.get(key);
    credits.set(key, { amount:(previous?.amount ?? 0) + amount,
      lastPaidOn:previous?.lastPaidOn > date ? previous.lastPaidOn : date });
  };
  for (const o of Object.values(book.operations)) {
    if (o.kind !== 'payment' || o.voided || o.date > today) continue;
    for (const item of o.id === replacedId ? [] : o.allocations) {
      if (item.month) add(item.serviceId, item.month, item.credit, o.date);
    }
    receipts.add(operationReceiptKey(book.services,o));
  }
  const recurring = new Map();
  for (const service of Object.values(book.services)) {
    if (service.kind === 'personal') continue;
    const key = `${service.clientId}/${service.block}`;
    if (!recurring.has(key)) recurring.set(key, []);
    recurring.get(key).push(service);
  }
  for (const row of state.ledger?.rows || []) {
    if (row.kind !== 'payment' || row.owners.length !== 1 || !validDate(row.date) || row.date > today) continue;
    const candidates = (recurring.get(`${row.owners[0]}/${row.block}`) || []).filter(service =>
      service.startsOn.slice(0,7) <= row.month && (!service.endsOn || dueDate(service,row.month) <= service.endsOn));
    for (const [currency, amount] of Object.entries(row.values)) {
      if (amount <= 0) continue;
      const receipt = receiptKey(row.owners,row.date,currency,amount);
      if (receipts.has(receipt)) continue;
      receipts.add(receipt);
      const parts = row.packageParts?.[currency];
      for (const [pkg, part] of parts ? Object.entries(parts) : [[row.package,amount]]) {
        const matches = candidates.filter(s => s.currency === currency && (!pkg || servicePackage(s) === pkg));
        if (matches.length === 1) add(matches[0].id,row.month,part,row.date);
      }
    }
  }
  return credits;
}

function chargeFor(credits, service, month, { settle = false, recordCovered = false } = {}) {
  if (!validMonth(month) || service.kind === 'personal') return null;
  const due = dueDate(service, month);
  if (month < service.startsOn.slice(0, 7) || (service.endsOn && due > service.endsOn)) return null;
  const payment = credits.get(`${service.id}/${month}`);
  const covered = Boolean(service.coveredThrough && month <= service.coveredThrough);
  const received = (payment?.amount ?? 0) >= service.rate;
  if ((!recordCovered && covered) || received) {
    return { due, remaining:0, lastPaidOn:payment?.lastPaidOn, coverageOnly:!received };
  }
  if (!settle && service.billingFrom && month < service.billingFrom) return null;
  return { due, remaining:service.rate - (payment?.amount ?? 0), lastPaidOn:payment?.lastPaidOn };
}

export function monthlyCharge(state, service, month, today = localDate()) {
  return chargeFor(monthlyCredits(state, today), service, month);
}

export function settleMonths(state, { serviceId, firstMonth, lastMonth = firstMonth, part, recordCovered = false }, replacedId, today = localDate()) {
  const service = accounting(state).services[serviceId];
  if (!service || service.kind === 'personal') throw Error('Выбери месячный тариф');
  if (!validMonth(firstMonth) || !validMonth(lastMonth) || firstMonth > lastMonth) throw Error('Проверь месяцы оплаты');
  if (!validMoney(part)) throw Error('Проверь сумму поступления');
  if (recordCovered && (lastMonth !== firstMonth || !(firstMonth <= service.coveredThrough))) {
    throw Error('Выбери закрытый месяц, за который поступили деньги');
  }
  const credits = monthlyCredits(state,today,replacedId);
  const open = [];
  for (let month = firstMonth, count = 0; ; month = nextMonth(month)) {
    if (++count > 120) throw Error('Слишком много месяцев в одной оплате');
    const charge = chargeFor(credits,service,month,{settle:true,recordCovered});
    if (!charge) throw Error('Выбранный месяц вне срока действия тарифа');
    if (charge.remaining > 0) open.push({ serviceId, month, credit:charge.remaining });
    if (month === lastMonth) break;
  }
  if (!open.length) throw Error(recordCovered ? 'За этот месяц уже записана полная оплата' : 'Выбранный период уже оплачен');
  const totalCredit = open.reduce((total, item) => total + BigInt(item.credit),0n);
  let apportioned = 0;
  let creditSoFar = 0n;
  return open.map(item => {
    creditSoFar += BigInt(item.credit);
    const upto = Number(BigInt(part) * creditSoFar / totalCredit);
    const share = upto - apportioned;
    if (!share) throw Error('Сумма слишком мала для распределения по этим месяцам');
    apportioned = upto;
    return { ...item, part:share };
  });
}

export function clientAccountHistory(state, clientId, today = localDate()) {
  const services = accounting(state).services;
  const recorded = operations(state,{clientId,includeVoided:true});
  const history = recorded.map(operation => ({ type:'operation', date:operation.date, operation }));
  const nativeReceipts = new Map();
  for (const operation of recorded) {
    if (operation.kind !== 'payment' || operation.voided) continue;
    const key = operationReceiptKey(services,operation);
    nativeReceipts.set(key,(nativeReceipts.get(key) ?? 0) + 1);
  }
  const imports = (state.ledger?.rows || []).filter(row => row.owners.includes(clientId) && ['payment','shared','session'].includes(row.kind));
  const reconciled = reconciledSessionRows(state,recorded,imports);
  const importedReceipts = new Map();
  for (const row of imports) {
    if (row.kind === 'session') continue;
    for (const [currency,amount] of Object.entries(row.values)) {
      const key = receiptKey(row.owners,row.date,currency,amount);
      if (key && amount > 0) importedReceipts.set(key,(importedReceipts.get(key) ?? 0) + 1);
    }
  }
  for (const row of imports) {
    if (reconciled.has(row.id)) continue;
    const values = row.kind === 'session' ? row.values : Object.fromEntries(Object.entries(row.values).filter(([currency,amount]) => {
      const key = receiptKey(row.owners,row.date,currency,amount);
      return amount > 0 && !(nativeReceipts.get(key) === 1 && importedReceipts.get(key) === 1);
    }));
    if (!Object.keys(values).length && row.kind !== 'session') continue;
    history.push({ type:'ledger',date:row.date || row.month+'-31',row:{...row,values} });
  }
  const credits = monthlyCredits(state,today);
  for (const service of clientServices(state,clientId)) {
    const through = service.coveredThrough;
    if (!through || (credits.get(`${service.id}/${through}`)?.amount ?? 0) >= service.rate) continue;
    const period = today.slice(0,7);
    history.push({ type:'coverage',date:through < period ? through+'-31' : today,service });
  }
  // Inferred coverage has no receipt date. Order it by period without showing an invented date.
  return history.sort((a,b) => b.date.localeCompare(a.date) || Number(a.type === 'coverage') - Number(b.type === 'coverage'));
}

export function filterClientAccountHistory(state, history, clientId, tariff = 'all') {
  if (tariff === 'all') return history;
  const services = accounting(state).services;
  const own = clientServices(state,clientId);
  const matches = service => service?.clientId === clientId && tariffKey(service) === tariff;
  const isPersonal = tariff === 'personal-gym' || tariff === 'personal-outside';
  return history.flatMap(item => {
    if (item.type === 'coverage') return matches(item.service) ? [item] : [];
    if (item.type === 'operation') {
      const operation = item.operation;
      if (operation.kind === 'session') return matches(services[operation.serviceId]) ? [item] : [];
      return operation.allocations.some(a => matches(services[a.serviceId])) ? [item] : [];
    }
    const source = item.row;
    const candidates = [...new Set(own.filter(s => s.block === source.block).map(servicePackage))];
    const fallback = source.kind === 'session' ? 'personal' : source.package ??
      (candidates.length === 1 ? candidates[0] : candidates.length ? null : source.block);
    const pkg = isPersonal ? 'personal' : tariff;
    if (isPersonal) {
      const personal = own.filter(s => s.kind === 'personal');
      const atPeriod = personal.filter(s => s.startsOn.slice(0,7) <= source.month && (!s.endsOn || s.endsOn.slice(0,7) >= source.month));
      const keys = new Set((atPeriod.length ? atPeriod : personal).map(tariffKey));
      if (keys.size !== 1 || !keys.has(tariff)) return [];
    }
    const values = Object.fromEntries(Object.entries(source.values).flatMap(([currency,amount]) => {
      const parts = source.packageParts?.[currency];
      const matched = parts ? parts[pkg] : fallback === pkg ? amount : 0;
      return matched > 0 ? [[currency,matched]] : [];
    }));
    return Object.keys(values).length ? [{...item,row:{...source,values}}] : [];
  });
}

export function paymentTiming(due, today) {
  if (today < due) return 'upcoming';
  if (today === due) return 'today';
  return today <= addDays(due, PAYMENT_GRACE_DAYS) ? 'grace' : 'overdue';
}

function billingStart(service) {
  const starts = service.startsOn.slice(0,7);
  return service.billingFrom > starts ? service.billingFrom : starts;
}

function clientMovements(state, clientId) {
  return state.events.filter(event => event.type === 'client-movement' && event.clientId === clientId)
    .reverse().sort((a,b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at));
}

function activeOn(movements, date) {
  const event = movements.find(item => item.day <= date);
  return !event || event.status === 'Активный';
}

export function currentPaymentStatuses(state, today = localDate(), clientId) {
  const month = today.slice(0,7);
  const credits = monthlyCredits(state,today);
  const result = new Map();
  const movements = new Map();
  for (const service of Object.values(accounting(state).services)) {
    const client = state.clients[service.clientId];
    if ((clientId && clientId !== service.clientId) || client?.status !== 'Активный' || client.mergedInto) continue;
    const active = activeService(service,today);
    if (service.kind === 'personal') {
      if (!service.oneOff && !active) continue;
      const { balance, used } = serviceBalance(state,service.id,today);
      if (service.oneOff && balance >= 0) continue;
      result.set(service.id, { type:balance < 0 ? 'pending' : balance > 0 || used ? 'paid' : 'none', balance, used });
      continue;
    }
    if (!active) continue;
    if (!movements.has(service.clientId)) movements.set(service.clientId,clientMovements(state,service.clientId));
    const events = movements.get(service.clientId);
    let previous;
    const first = billingStart(service);
    const earliest = service.coveredThrough >= first ? nextMonth(service.coveredThrough) : first;
    for (let period = earliest; period < month; period = nextMonth(period)) {
      const bill = chargeFor(credits,service,period);
      if (!bill?.remaining || !activeOn(events,bill.due)) continue;
      previous ??= { month:period, due:bill.due, remaining:0, timing:paymentTiming(bill.due,today) };
      previous.remaining += bill.remaining;
    }
    const charge = chargeFor(credits,service,month);
    const next = service.billingFrom > month ? service.billingFrom : nextMonth(month);
    if (!charge || !charge.remaining || !activeOn(events,charge.due)) {
      let nextPeriod = service.coveredThrough >= next ? nextMonth(service.coveredThrough) : next;
      let nextCharge = chargeFor(credits,service,nextPeriod);
      while (nextCharge && !nextCharge.remaining) {
        nextPeriod = nextMonth(nextPeriod);
        nextCharge = chargeFor(credits,service,nextPeriod);
      }
      result.set(service.id,{ ...charge, month, type:charge?.remaining === 0 ? 'paid' : 'none', nextDue:nextCharge?.due, previous });
      continue;
    }
    const timing = paymentTiming(charge.due,today);
    result.set(service.id,{ ...charge, month, timing, type:timing === 'overdue' ? 'overdue' : 'pending', previous });
  }
  return result;
}

export function clientPaymentStatuses(state, today = localDate()) {
  const services = accounting(state).services;
  const result = new Map();
  const priority = { paid:1, pending:2, overdue:3 };
  for (const [serviceId, { type:current, previous }] of currentPaymentStatuses(state,today)) {
    const older = previous?.timing === 'overdue' ? 'overdue' : previous ? 'pending' : 'none';
    const type = (priority[older] ?? 0) > (priority[current] ?? 0) ? older : current;
    if (type === 'none') continue;
    const { clientId } = services[serviceId];
    if (priority[type] > (priority[result.get(clientId)] ?? 0)) result.set(clientId,type);
  }
  return result;
}

export function paymentReminders(state, today = localDate()) {
  const book = accounting(state);
  const credits = monthlyCredits(state, today);
  const next = [];
  for (const service of Object.values(book.services)) {
    const client = state.clients[service.clientId];
    if (service.kind === 'personal' || !service.reminder || client.role !== 'Клиент' || client.status !== 'Активный') continue;
    const horizon = addDays(today, book.reminders[service.block] ?? DEFAULT_REMINDERS[service.block]);
    const events = clientMovements(state,service.clientId);
    const first = billingStart(service);
    for (let month = first; month <= horizon.slice(0, 7); month = nextMonth(month)) {
      const due = dueDate(service, month);
      if (service.endsOn && due > service.endsOn) break;
      if (due > horizon || (service.coveredThrough && month <= service.coveredThrough)) continue;
      if (!activeOn(events,due)) continue;
      const remaining = chargeFor(credits,service,month)?.remaining ?? 0;
      if (remaining > 0) next.push({ service, month, due, remaining });
    }
  }
  return next.sort((a, b) => a.due.localeCompare(b.due) || a.service.id.localeCompare(b.service.id));
}

export function movementFor(state, month) {
  return state.events.filter(e => e.type === 'client-movement' && e.movement && e.day.startsWith(month + '-'))
    .sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at));
}

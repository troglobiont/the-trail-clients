import { addDays, id, localDate, validDate } from './model-utils.js';

export const SERVICES = {
  belgrade: 'Группа Белграда', online: 'Онлайн-ведение',
  coaching: 'Премиум онлайн', personal: 'Персональная тренировка'
};
export const PACKAGES = { ...SERVICES, gym:'План Gym', trainingpeaks:'TrainingPeaks' };
export const packageKind = key => key === 'gym' || key === 'trainingpeaks' ? 'coaching' : key;
export const servicePackage = service => service.package || service.kind;
export const BLOCKS = { belgrade: 'Белград', online: 'Онлайн', personal: 'Персональные' };
export const CURRENCIES = ['RSD', 'RUB', 'EUR', 'USD'];
export const PLACES = ['Зал', 'Улица'];
export const EXPENSES = ['Оплата тренеру', 'Налоги', 'Реклама', 'Прочее'];
export const MOVEMENT = { new: 'Новые', returned: 'Вернулись', paused: 'На паузе', ended: 'Завершили' };
export const DEFAULT_REMINDERS = { belgrade: 3, online: 0, personal: 0 };
const EMPTY = { services: {}, operations: {}, reminders: {} };
const MAX_AMOUNT = 100000000000;
const validMoney = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT;
const validKey = key => typeof key === 'string' && /^[-a-zA-Z0-9_]{1,180}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validNote = value => typeof value === 'string' && value.length <= 300;
const validReminder = days => Number.isInteger(days) && days >= 0 && days <= 30;
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
  } else if (!Number.isInteger(day) || day < 1 || day > 31 || typeof reminder !== 'boolean' || place !== null) {
    throw Error('Укажи день оплаты от 1 до 31');
  } else if ([service.billingFrom, service.coveredThrough].some(month => month != null && !validMonth(month))) {
    throw Error('Проверь месяц начисления или предоплаты');
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

export function savePaidSession(state, values, received, paymentDate = values.date) {
  const session = prepareOperation(state, { ...values, kind: 'session' }, id('operation'));
  const payment = prepareOperation(state, {
    kind: 'payment', date: paymentDate, amount: received, currency: session.currency, note: '', payer: '',
    sessionId: session.id, allocations: [{ serviceId: session.serviceId, month: null, part: received, credit: received }]
  }, id('operation'));
  Object.assign(writable(state).operations, { [session.id]: session, [payment.id]: payment });
  return [session, payment];
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
    if (packageFilter === 'personal-gym') return key === 'personal' && s.place === 'Зал';
    return key === packageFilter;
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
  for (const operation of operations(state,{month})) {
    if (operation.kind !== 'payment') continue;
    const owners = operation.allocations.map(item => book.services[item.serviceId].clientId);
    const key = receiptKey(owners,operation.date,operation.currency,operation.amount);
    nativeByKey.set(key,(nativeByKey.get(key)||0)+1);
  }
  for (const row of state.ledger?.rows || []) {
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

function dueDate(service, month) {
  const last = new Date(month + '-01T12:00:00Z');
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const day = String(Math.min(service.day, last.getUTCDate())).padStart(2, '0');
  const due = `${month}-${day}`;
  return due < service.startsOn ? service.startsOn : due;
}

function monthlyCredits(book, today) {
  const credits = new Map();
  for (const o of Object.values(book.operations)) {
    if (o.kind !== 'payment' || o.voided || o.date > today) continue;
    for (const item of o.allocations) {
      const key = `${item.serviceId}/${item.month}`;
      credits.set(key, (credits.get(key) ?? 0) + item.credit);
    }
  }
  return credits;
}

export function monthlyCharge(state, service, month, today = localDate()) {
  const due = dueDate(service, month);
  if (month < service.startsOn.slice(0, 7) || (service.endsOn && due > service.endsOn)) return null;
  if (service.coveredThrough && month <= service.coveredThrough) return { due, remaining:0 };
  if (service.billingFrom && month < service.billingFrom) return null;
  const credits = monthlyCredits(accounting(state), today);
  return { due, remaining: Math.max(0, service.rate - (credits.get(`${service.id}/${month}`) ?? 0)) };
}

export function paymentReminders(state, today = localDate()) {
  const book = accounting(state);
  const credits = monthlyCredits(book, today);
  const next = [];
  for (const service of Object.values(book.services)) {
    const client = state.clients[service.clientId];
    if (service.kind === 'personal' || !service.reminder || client.role !== 'Клиент' || client.status !== 'Активный') continue;
    const horizon = addDays(today, book.reminders[service.block] ?? DEFAULT_REMINDERS[service.block]);
    const events = state.events.filter(e => e.type === 'client-movement' && e.clientId === service.clientId).reverse().sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at));
    const starts = service.startsOn.slice(0, 7);
    const first = service.billingFrom > starts ? service.billingFrom : starts;
    for (let month = first; month <= horizon.slice(0, 7); month = nextMonth(month)) {
      const due = dueDate(service, month);
      if (service.endsOn && due > service.endsOn) break;
      if (due > horizon || (service.coveredThrough && month <= service.coveredThrough)) continue;
      const status = events.find(e => e.day <= due);
      if (status && status.status !== 'Активный') continue;
      const remaining = service.rate - (credits.get(`${service.id}/${month}`) ?? 0);
      if (remaining > 0) next.push({ service, month, due, remaining });
    }
  }
  return next.sort((a, b) => a.due.localeCompare(b.due) || a.service.id.localeCompare(b.service.id));
}

export function movementFor(state, month) {
  return state.events.filter(e => e.type === 'client-movement' && e.movement && e.day.startsWith(month + '-'))
    .sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at));
}

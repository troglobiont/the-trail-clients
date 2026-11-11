import { addDays, id, localDate, validDate } from './model-utils.js';

export const SERVICES = {
  belgrade: 'Группа Белграда', online: 'Онлайн-группа',
  coaching: 'Персональное ведение', personal: 'Персональные занятия'
};
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
  return `${units} ${symbols[currency]}`;
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
  if (kind === 'personal') {
    if (day !== null || reminder !== false || !PLACES.includes(place)) throw Error('Выбери место занятия');
  } else if (!Number.isInteger(day) || day < 1 || day > 31 || typeof reminder !== 'boolean' || place !== null) {
    throw Error('Укажи день оплаты от 1 до 31');
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
    if (history.length && ['kind', 'clientId', 'currency', 'block'].some(key => before[key] !== service[key])) {
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
  if (operation.kind === 'session' && (prior?.serviceId !== operation.serviceId || prior?.date !== operation.date)
      && !activeService(book.services[operation.serviceId], operation.date)) throw Error('На эту дату услуга не действовала');
  return operation;
}

export function saveOperation(state, values, operationId = id('operation')) {
  const operation = prepareOperation(state, values, operationId);
  writable(state).operations[operationId] = operation;
  return operation;
}

export function savePaidSession(state, values, received) {
  const session = prepareOperation(state, { ...values, kind: 'session' }, id('operation'));
  const payment = prepareOperation(state, {
    kind: 'payment', date: session.date, amount: received, currency: session.currency, note: '', payer: '',
    sessionId: session.id, allocations: [{ serviceId: session.serviceId, month: null, part: received, credit: received }]
  }, id('operation'));
  Object.assign(writable(state).operations, { [session.id]: session, [payment.id]: payment });
  return [session, payment];
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
  return { received, used, balance: received - used };
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
        addTotal(result.services[service.kind] ??= {}, currency, item.part);
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
    for (let month = service.startsOn.slice(0, 7); month <= horizon.slice(0, 7); month = nextMonth(month)) {
      const due = dueDate(service, month);
      if (service.endsOn && due > service.endsOn) break;
      if (due > horizon) continue;
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

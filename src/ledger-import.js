import { PACKAGES } from './accounting.js';
import { validDate } from './model-utils.js';

export const LEDGER_FORMAT = 'the-trail-ledger-import';
const currencies = ['RSD', 'RUB', 'EUR', 'USD'];
const kinds = ['payment', 'review', 'repeat', 'shared', 'session', 'expense'];
const blocks = ['online', 'belgrade', 'personal', 'expenses', 'balance'];
const peer = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const key = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const string = (value, limit) => typeof value === 'string' && value.length <= limit;
const month = value => typeof value === 'string' && /^2026-(0[1-9]|1[0-2])$/.test(value);
const sourceLink = value => string(value, 300) && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/edit#gid=\d+(?:&range=[A-Z0-9:]+)?$/.test(value);
const amounts = values => values && typeof values === 'object' && !Array.isArray(values)
  && Object.entries(values).every(([currency, amount]) => currencies.includes(currency) && Number.isSafeInteger(amount) && Math.abs(amount) <= 100000000000);
const positiveAmount = amount => Number.isSafeInteger(amount) && amount > 0 && amount <= 100000000000;

export const nameKey = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');

export function editablePaymentCurrency(row) {
  if (row?.kind !== 'payment' || row.owners?.length !== 1 || !validDate(row.date)) return null;
  const keys = Object.keys(row.values);
  const [currency] = keys;
  return keys.length === 1 && currencies.includes(currency) && positiveAmount(row.values[currency]) && !row.packageParts?.[currency] ? currency : null;
}

function sameImportedPayment(row, other, currency) {
  return currency && editablePaymentCurrency(other) === currency && row.id === other.id && row.date === other.date &&
    row.month === other.month && row.block === other.block && row.owners[0] === other.owners[0];
}

export function changeImportedPaymentAmount(state, previous, amount) {
  if (!positiveAmount(amount)) throw Error('Проверь сумму оплаты');
  const row = state.ledger?.rows.find(item=>item.id===previous.id);
  const currency = editablePaymentCurrency(row);
  if (!sameImportedPayment(row,previous,currency) || row.values[currency] !== previous.values[currency]) {
    throw Error('Запись изменилась. Открой её заново');
  }
  const original = row.originalPaymentAmount ?? row.values[currency];
  row.values = {[currency]:amount};
  if (amount === original) delete row.originalPaymentAmount;
  else row.originalPaymentAmount = original;
  return row;
}

function validateLedger(ledger, owners) {
  if (!ledger || !key(ledger.datasetId) || !validDate(ledger.asOf) || !Array.isArray(ledger.rows) || ledger.rows.length > 15000
      || !Array.isArray(ledger.months) || ledger.months.length > 12) throw Error('Некорректный файл учёта');
  const periods = new Set();
  for (const item of ledger.months) {
    if (!item || !month(item.month) || periods.has(item.month) || !sourceLink(item.link) || !item.blocks
        || Object.entries(item.blocks).some(([k, v]) => !blocks.includes(k) || !amounts(v))) throw Error('Некорректный месячный итог');
    periods.add(item.month);
  }
  const ids = new Set();
  for (const row of ledger.rows) {
    if (!row || !key(row.id) || ids.has(row.id) || !periods.has(row.month) || !blocks.includes(row.block) || !kinds.includes(row.kind)
        || !string(row.name, 180) || !string(row.detail, 420) || !amounts(row.values) || !sourceLink(row.link)
        || (row.date !== '' && !validDate(row.date)) || !Array.isArray(row.owners) || row.owners.length > 10
        || row.owners.some(id => !key(id) || !owners.has(id))) throw Error('Некорректная строка истории учёта');
    if (row.package && !Object.hasOwn(PACKAGES,row.package)) throw Error('Некорректный пакет оплаты');
    if (row.originalPaymentAmount !== undefined && (!editablePaymentCurrency(row) || !positiveAmount(row.originalPaymentAmount))) {
      throw Error('Некорректная правка суммы из бухгалтерии');
    }
    if (row.sourceLedgerRowId !== undefined && (row.kind!=='session' || !key(row.sourceLedgerRowId)
        || (row.place !== undefined && !['Зал','Улица'].includes(row.place)))) throw Error('Некорректная связь с историей занятий');
    for (const [currency, parts] of Object.entries(row.packageParts||{})) {
      if (!currencies.includes(currency) || !parts || typeof parts!=='object' || Array.isArray(parts)
        || Object.entries(parts).some(([pkg,value])=>!Object.hasOwn(PACKAGES,pkg)||!Number.isSafeInteger(value)||value<=0)
        || Object.values(parts).reduce((sum,value)=>sum+value,0)!==row.values[currency]) throw Error('Некорректное распределение оплаты');
    }
    ids.add(row.id);
  }
  return ledger;
}

export function parseLedgerImport(file) {
  if (file?.format !== LEDGER_FORMAT || file.version !== 1 || !Array.isArray(file.profiles) || file.profiles.length > 5000) throw Error('Это не файл переноса учёта THE.TRAIL');
  const people = new Set();
  for (const profile of file.profiles) {
    if (!profile || !key(profile.id) || people.has(profile.id) || !string(profile.name, 180) || !profile.name.trim()
        || !['Клиент', 'Тренер'].includes(profile.role) || typeof profile.create !== 'boolean' || !Array.isArray(profile.aliases)
        || profile.aliases.length > 30 || !profile.aliases.every(alias => string(alias, 180))) throw Error('Некорректное соответствие имён');
    const binding = profile.telegram;
    if (binding && (!peer(binding.peerId) || !peer(binding.accountPeerId) || !string(binding.displayName, 180)
        || (binding.username !== null && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(binding.username ?? ''))
        || !Number.isFinite(Date.parse(binding.verifiedAt)))) throw Error('Некорректная привязка Telegram');
    if (profile.telegramHint !== undefined && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(profile.telegramHint)) throw Error('Некорректное имя Telegram');
    people.add(profile.id);
  }
  return validateLedger(file, people);
}

export function validateStoredLedger(state) {
  if (state.ledger !== undefined) validateLedger(state.ledger, new Set(Object.keys(state.clients)));
}

export function applyLedger(state, file, { createClient, setTelegramBinding }) {
  parseLedgerImport(file);
  if (state.ledger?.datasetId === file.datasetId) return null;
  const cards = Object.values(state.clients);
  const names = new Map();
  const knownPeers = new Set(cards.map(c => c.telegram?.peerId).filter(Boolean));
  for (const c of cards) {
    for (const value of [c.name, ...(c.aliases || [])]) {
      const normalized = nameKey(value);
      if (!names.has(normalized)) names.set(normalized, new Set());
      names.get(normalized).add(c);
    }
  }
  const owners = new Map();
  let created = 0;
  let bound = 0;
  let matched = 0;
  for (const p of file.profiles) {
    const exact = new Set([p.name, ...p.aliases].flatMap(name => [...(names.get(nameKey(name)) || [])]));
    let c = state.clients[p.id];
    if (!c && exact.size === 1) [c] = exact;
    if (!c && exact.size === 0 && p.create) {
      c = createClient(state, { id: p.id, name: p.name, status: 'Нужно уточнить', role: p.role });
      created++;
    }
    if (!c || c.role !== p.role || [...owners.values()].includes(c.id)) continue;
    c.aliases = [...new Set([...(c.aliases || []), c.name, ...p.aliases])].filter(name => name !== p.name);
    c.name = p.name;
    owners.set(p.id, c.id);
    matched++;
    if (p.telegramHint && !c.telegramHint) c.telegramHint = p.telegramHint;
    if (p.telegram && !c.telegram && !c.ledgerTelegramApplied && !knownPeers.has(p.telegram.peerId) && !state.settings.pendingTelegram?.[c.id]) {
      setTelegramBinding(state, c.id, p.telegram);
      knownPeers.add(p.telegram.peerId);
      c.ledgerTelegramApplied = true;
      bound++;
    }
  }
  const previousRows = new Map((state.ledger?.rows || []).map(row=>[row.id,row]));
  const detailed = new Map();
  for (const row of state.ledger?.rows || []) if (row.sourceLedgerRowId) {
    const children = detailed.get(row.sourceLedgerRowId) || [];
    children.push(row);
    detailed.set(row.sourceLedgerRowId,children);
  }
  const fileRows = new Set(file.rows.map(row=>row.id));
  const fileMonths = new Set(file.months.map(period=>period.month));
  state.ledger = {
    datasetId: file.datasetId, asOf: file.asOf, months: file.months,
    rows: file.rows.flatMap(row => {
      const mapped = {...row,owners:[...new Set(row.owners.map(id=>owners.get(id)).filter(Boolean))]};
      const old = previousRows.get(row.id);
      const sessions = detailed.get(row.id) || [];
      if (old?.kind==='repeat' && old.sourceKind===mapped.kind && old.month===mapped.month && old.date===mapped.date && old.detail===mapped.detail
          && old.block===mapped.block && old.owners.length===mapped.owners.length && old.owners.every(id=>mapped.owners.includes(id))
          && currencies.every(currency=>old.values[currency]===mapped.values[currency]) && sessions.every(item=>fileMonths.has(item.month))) {
        const archived = {...mapped,kind:'repeat',sourceKind:old.sourceKind};
        return [archived,...sessions.filter(item=>!fileRows.has(item.id)).map(item=>({...item,name:mapped.name,owners:mapped.owners}))];
      }
      const currency = editablePaymentCurrency(mapped);
      if (!currency) delete mapped.originalPaymentAmount;
      if (old?.originalPaymentAmount && sameImportedPayment(mapped,old,currency) &&
          [old.originalPaymentAmount,old.values[currency]].includes(mapped.values[currency])) {
        return {...mapped,values:old.values,originalPaymentAmount:old.originalPaymentAmount};
      }
      return mapped;
    })
  };
  return { matched, created, bound, rows: state.ledger.rows.length };
}

export function ledgerRows(state, { clientId, period } = {}) {
  return (state.ledger?.rows || []).filter(row => (!clientId || row.owners.includes(clientId)) && (!period || row.month === period))
    .sort((a,b) => b.month.localeCompare(a.month) || b.date.localeCompare(a.date));
}

import { CURRENCIES as currencies, PACKAGES } from './accounting.js';
import { localDate, validDate } from './model-utils.js';

export const LEDGER_FORMAT = 'the-trail-ledger-import';
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

export function editableImportedPayment(row) {
  return Boolean(row && ['payment','shared'].includes(row.kind) && Object.values(row.values).some(positiveAmount) &&
    Object.values(row.values).every(amount=>amount >= 0));
}

function validParts(parts, amount) {
  return parts && typeof parts === 'object' && !Array.isArray(parts) &&
    Object.entries(parts).every(([pkg,value])=>Object.hasOwn(PACKAGES,pkg) && positiveAmount(value)) &&
    Object.values(parts).reduce((sum,value)=>sum+value,0) === amount;
}

function validDistribution(parts, values) {
  return parts == null || Boolean(typeof parts === 'object' && !Array.isArray(parts) &&
    Object.entries(parts).every(([currency,split])=>currencies.includes(currency) && validParts(split,values[currency])));
}

function samePaymentRow(row, other) {
  return row.id === other.id && row.kind === other.kind && row.month === other.month && row.block === other.block &&
    row.package === other.package && row.owners.length === other.owners.length && row.owners.every(id=>other.owners.includes(id));
}

function sameValues(first, second) {
  return Object.keys(first ?? {}).length === Object.keys(second ?? {}).length &&
    Object.entries(first ?? {}).every(([key,value])=>second?.[key] === value);
}

function sameReceipt(first, second) {
  return first.date === second.date && sameValues(first.values,second.values) &&
    currencies.every(currency=>sameValues(first.packageParts?.[currency],second.packageParts?.[currency]));
}

function paymentFields(row) {
  return {date:row.date,values:row.values,...(row.packageParts && {packageParts:row.packageParts})};
}

export function importedPaymentOriginal(row) {
  if (row.paymentOriginal) return row.paymentOriginal;
  if (row.originalPaymentAmount !== undefined) {
    const [currency] = Object.keys(row.values);
    return {date:row.date,values:{[currency]:row.originalPaymentAmount}};
  }
  return null;
}

export function changeImportedPayment(state, previous, {date, entries}) {
  if (!validDate(date) || date > localDate()) throw Error('Укажи дату фактической операции');
  const rows = state.ledger?.rows;
  const index = rows?.findIndex(item=>item.id===previous.id);
  const row = rows?.[index];
  if (!editableImportedPayment(row) || !samePaymentRow(row,previous) || !sameReceipt(row,previous)) {
    throw Error('Запись изменилась. Открой её заново');
  }
  if (entries.length !== Object.values(row.values).filter(positiveAmount).length) throw Error('Проверь список сумм оплаты');
  const values = {}, packageParts = {}, paymentCredits = {};
  const editedCurrencies = new Set();
  for (const {from, currency, amount, parts} of entries) {
    if (!currencies.includes(from) || !currencies.includes(currency) || !positiveAmount(row.values[from]) ||
        editedCurrencies.has(from) || !positiveAmount(amount)) throw Error('Проверь сумму и валюту оплаты');
    if (Object.hasOwn(values,currency)) throw Error('Выбери разные валюты для сумм в этой записи');
    editedCurrencies.add(from);
    const priorParts = row.packageParts?.[from];
    if (Boolean(priorParts) !== Boolean(parts) || parts && (!validParts(parts,amount) ||
        Object.keys(priorParts).length !== Object.keys(parts).length || Object.keys(priorParts).some(pkg=>!Object.hasOwn(parts,pkg)))) {
      throw Error('Суммы по услугам должны совпадать с поступлением');
    }
    values[currency] = amount;
    if (parts) packageParts[currency] = {...parts};
    const credit = row.paymentCredits?.[from] ?? {currency:from,amount:row.values[from],...(priorParts && {parts:priorParts})};
    if (row.kind === 'payment' && row.owners.length === 1 && credit.currency !== currency) paymentCredits[currency] = credit;
  }
  for (const currency of currencies) if (row.values[currency] === 0 && !Object.hasOwn(values,currency)) values[currency] = 0;
  const {originalPaymentAmount, paymentOriginal, paymentCredits:previousCredits, packageParts:previousParts, ...rest} = row;
  const corrected = {...rest,date,values,...(Object.keys(packageParts).length && {packageParts})};
  const original = importedPaymentOriginal(row) ?? paymentFields(row);
  if (!sameReceipt(corrected,original)) {
    corrected.paymentOriginal = original;
    if (Object.keys(paymentCredits).length) corrected.paymentCredits = paymentCredits;
  }
  rows[index] = corrected;
  return corrected;
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
    if (row.originalPaymentAmount !== undefined && (!editableImportedPayment(row) || row.kind !== 'payment' || row.owners.length !== 1 ||
        !validDate(row.date) || Object.keys(row.values).length !== 1 || Object.keys(row.packageParts ?? {}).length ||
        !positiveAmount(row.originalPaymentAmount))) {
      throw Error('Некорректная правка суммы из бухгалтерии');
    }
    if (row.paymentOriginal !== undefined) {
      const original = row.paymentOriginal;
      if (!editableImportedPayment(row) || !original || (original.date !== '' && !validDate(original.date)) ||
          !amounts(original.values) || !validDistribution(original.packageParts,original.values)) throw Error('Некорректная исходная оплата');
    }
    if (row.sourceLedgerRowId !== undefined && (row.kind!=='session' || !key(row.sourceLedgerRowId)
        || (row.place !== undefined && !['Зал','Улица'].includes(row.place)))) throw Error('Некорректная связь с историей занятий');
    if (!validDistribution(row.packageParts,row.values)) throw Error('Некорректное распределение оплаты');
    if (row.paymentCredits !== undefined && (!row.paymentOriginal || !row.paymentCredits || typeof row.paymentCredits !== 'object' ||
        Array.isArray(row.paymentCredits) || Object.entries(row.paymentCredits).some(([currency,credit])=>
          !Object.hasOwn(row.values,currency) || !positiveAmount(row.values[currency]) || !credit || !currencies.includes(credit.currency) ||
          currency === credit.currency || !positiveAmount(credit.amount) || credit.parts && !validParts(credit.parts,credit.amount)))) {
      throw Error('Некорректная сумма в валюте тарифа');
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
  if (state.ledger === undefined) return;
  validateLedger(state.ledger, new Set(Object.keys(state.clients)));
  const comparison = state.ledger.comparison;
  if (comparison !== undefined && (!comparison || Array.isArray(comparison)||typeof comparison!=='object'
      ||Object.entries(comparison).some(([period,value])=>!month(period)||!value
        ||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt))
        ||!sourceLink(value.link)||!value.blocks||typeof value.blocks!=='object'||Array.isArray(value.blocks)
        ||Object.entries(value.blocks).some(([block,values])=>!blocks.includes(block)||!amounts(values)))))
    throw Error('Некорректный срез для сравнения учёта');
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
    ...(state.ledger?.comparison&&{comparison:state.ledger.comparison}),
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
      if (mapped.owners.length !== 1) delete mapped.originalPaymentAmount;
      const original = old && importedPaymentOriginal(old);
      if (original && samePaymentRow(mapped,old) && (sameReceipt(mapped,original) || sameReceipt(mapped,old))) {
        delete mapped.packageParts;
        delete mapped.originalPaymentAmount;
        delete mapped.paymentCredits;
        return {...mapped,...paymentFields(old),paymentOriginal:original,...(old.paymentCredits && {paymentCredits:old.paymentCredits})};
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

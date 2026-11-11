const collections = ['clients', 'goals', 'tasks', 'records', 'events', 'services', 'operations', 'reminders', 'ledger'];
const core = collections.slice(0, 4);
const keyFor = (collection, id) => `${collection}/${id}`;
const split = key => key.split('/');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && same(a[key], b[key]));
}

export function cloudData(state) {
  return {
    ...Object.fromEntries(core.map(key => [key, state[key]])),
    events: Object.fromEntries(state.events.map(event => [event.id, event])),
    services: state.accounting?.services ?? {}, operations: state.accounting?.operations ?? {}, reminders: state.accounting?.reminders ?? {},
    ledger: state.ledger ? { import: state.ledger } : {}
  };
}

const get = (data, key) => {
  const [bucket, id] = split(key);
  const entries = data[bucket];
  return entries && own(entries, id) ? entries[id] : null;
};

function set(data, key, value) {
  const [bucket, id] = split(key);
  if (value === null) delete data[bucket][id];
  else data[bucket][id] = value;
}

export function validateCloudState(state) {
  const sync = state.cloudSync;
  if (!sync) return;
  if (!/^[a-f0-9-]{36}$/i.test(sync.owner) || !Number.isSafeInteger(sync.revision) || sync.revision < -1
      || !sync.pending || typeof sync.pending !== 'object' || Array.isArray(sync.pending)) throw Error('Некорректные данные синхронизации');
  for (const key of Object.keys(sync.pending)) {
    const [bucket, id, extra] = split(key);
    if (!collections.includes(bucket) || !/^[-a-zA-Z0-9_]{1,180}$/.test(id) || ['__proto__','constructor','prototype'].includes(id) || extra !== undefined) throw Error('Некорректная запись синхронизации');
  }
  if (sync.flight && (!/^[a-f0-9-]{36}$/i.test(sync.flight.id) || sync.flight.revision !== sync.revision
    || !sync.flight.changes || typeof sync.flight.changes !== 'object' || Array.isArray(sync.flight.changes))) throw Error('Некорректный пакет синхронизации');
}

export function beginCloudSync(state, owner) {
  if (state.cloudSync) {
    if (state.cloudSync.owner !== owner) throw Error('База телефона подключена к другому аккаунту');
    return;
  }
  const pending = {};
  for (const [bucket, items] of Object.entries(cloudData(state))) {
    for (const id of Object.keys(items)) pending[keyFor(bucket,id)] = null;
  }
  state.cloudSync = { owner, revision: -1, pending, flight: null, syncedAt: null };
}

export function trackCloudChanges(previous, next) {
  if (!previous.cloudSync) return;
  next.cloudSync ??= JSON.parse(JSON.stringify(previous.cloudSync));
  const before = cloudData(previous), after = cloudData(next);
  const pending = next.cloudSync.pending;
  for (const bucket of collections) {
    for (const id of new Set([...Object.keys(before[bucket]), ...Object.keys(after[bucket])])) {
      const key = keyFor(bucket, id), old = get(before, key), value = get(after, key);
      if (same(old, value)) continue;
      if (!own(pending, key)) pending[key] = old;
      if (same(value, pending[key])) delete pending[key];
    }
  }
}

export function prepareCloudWrite(state) {
  const sync = state.cloudSync;
  if (sync.flight) return sync.flight;
  if (sync.revision < 0 || !Object.keys(sync.pending).length) return null;
  const local = cloudData(state), changes = {};
  for (const key of Object.keys(sync.pending)) {
    const [bucket, id] = split(key);
    (changes[bucket] ??= {})[id] = get(local, key);
  }
  sync.flight = { id: crypto.randomUUID(), revision: sync.revision, changes };
  return sync.flight;
}

export function acknowledgeCloudWrite(state, flight, result) {
  const sync = state.cloudSync;
  if (sync.flight?.id !== flight.id) return;
  if (!Number.isSafeInteger(result?.revision) || result.revision <= flight.revision || typeof result.applied !== 'boolean') throw Error('Облако не подтвердило сохранение');
  sync.flight = null;
  if (!result.applied) return;
  const local = cloudData(state);
  for (const [bucket, entries] of Object.entries(flight.changes)) {
    for (const [id, value] of Object.entries(entries)) {
      const key = keyFor(bucket, id);
      if (same(get(local, key), value)) delete sync.pending[key];
      else sync.pending[key] = value;
    }
  }
  sync.revision = result.revision;
  sync.syncedAt = new Date().toISOString();
}

export function receiveCloudData(state, response, choices = {}) {
  const sync = state.cloudSync;
  if (!Number.isSafeInteger(response?.revision) || response.revision < Math.max(sync.revision, 0)) throw Error('Некорректная версия базы в облаке');
  if (response.data === null && response.revision === sync.revision) {
    sync.syncedAt = new Date().toISOString();
    return [];
  }
  const raw = response.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Облако не вернуло базу');
  for (const [bucket, entries] of Object.entries(raw)) {
    if (!collections.includes(bucket) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('Некорректная база в облаке');
  }
  const remote = Object.fromEntries(collections.map(key => [key, { ...raw[key] }]));
  const local = cloudData(state), pending = {};
  const conflicts = [];
  for (const [key, before] of Object.entries(sync.pending)) {
    const value = get(local, key), upstream = get(remote, key);
    if (same(value, upstream)) continue;
    const conflict = !same(upstream, before);
    if (conflict && !own(choices, key)) {
      conflicts.push({ key, local: value, remote: upstream });
      continue;
    }
    if (conflict && choices[key] === 'cloud') continue;
    pending[key] = upstream;
    set(remote, key, value);
  }
  if (conflicts.length) return conflicts;
  for (const key of core) state[key] = remote[key];
  state.events = Object.values(remote.events).sort((a,b) => a.at.localeCompare(b.at));
  if (state.accounting || Object.keys(remote.services).length || Object.keys(remote.operations).length || Object.keys(remote.reminders).length) {
    state.accounting = { services: remote.services, operations: remote.operations, reminders: remote.reminders };
  }
  if (remote.ledger.import) state.ledger = remote.ledger.import;
  else delete state.ledger;
  sync.revision = response.revision;
  sync.pending = pending;
  sync.syncedAt = new Date().toISOString();
  return [];
}

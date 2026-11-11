import assert from 'node:assert/strict';
import test from 'node:test';
import * as C from '../src/core.js';
import { applyLedger, ledgerRows } from '../src/ledger-import.js';

const source = 'https://docs.google.com/spreadsheets/d/source/edit#gid=42';
const binding = id => ({ peerId: id, accountPeerId: '10', displayName: 'Контакт', username: null, verifiedAt: '2026-01-01T00:00:00Z' });

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

test('directory filters names in either order and keeps surname order under quick filters', () => {
  const state = C.emptyState();
  C.createClient(state, { name: 'Друзык Марина', aliases: ['Marina Druzyk'], format: 'Дистанционно' }, '2026-01-01');
  C.createClient(state, { name: 'Арендарь Александра', format: 'Очно', personal: 'gym' }, '2026-01-01');
  C.createClient(state, { name: 'Гилажев Айдар', format: 'Очно', personal: 'gym' }, '2026-01-01');
  assert.deepEqual(C.filterClients(state, { quick: 'gym' }).map(c => c.name), ['Арендарь Александра', 'Гилажев Айдар']);
  assert.deepEqual(C.filterClients(state, { quick: 'Дистанционно', query: 'Марина Друзык' }).map(c => c.name), ['Друзык Марина']);
  assert.deepEqual(C.filterClients(state, { query: 'Druzyk Marina' }).map(c => c.name), ['Друзык Марина']);
});

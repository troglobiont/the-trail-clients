import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantKind, suggestAssistantClients } from '../src/assistant.js';

const clients = [
  { id:'vera', name:'Стрижевская Вера', aliases:['Vera Strizhevskaia'] },
  { id:'another', name:'Иванова Вера' },
  { id:'merged', name:'Трижевская Вера', mergedInto:'vera' }
];

test('assistant proposes the card for a split or misspelled surname and asks for a choice', () => {
  for (const text of ['С Трижевской нужно связаться', 'Стрежевской нужно оплатить занятие', 'Трижевская оплатила занятие']) {
    assert.deepEqual(suggestAssistantClients(text, clients), { selected:'', suggestions:['vera'] });
  }
  assert.deepEqual(suggestAssistantClients('Спросить Стрижевскую о тренировке',clients), { selected:'vera', suggestions:['vera'] });
  assert.equal(suggestAssistantClients('Strizhevskaia Vera',clients).selected,'vera');
});

test('assistant retains multiple clients when it only recognizes their shared name', () => {
  assert.deepEqual(suggestAssistantClients('Спросить о самочувствии',clients), { selected:'', suggestions:[] });
  assert.deepEqual(suggestAssistantClients('Спросить Вера',clients), { selected:'', suggestions:['vera','another'] });
  assert.equal(suggestAssistantClients('Вера Стрижевская',clients).selected,'vera');
});

test('assistant distinguishes a requested payment follow-up from a reported receipt', () => {
  assert.equal(assistantKind('Стрежевской нужно оплатить персональную тренировку на улице'),'task');
  assert.equal(assistantKind('Напомни Иванову оплатить тренировку'),'task');
  assert.equal(assistantKind('Стрежевская оплатила персоналку в зале'),'payment');
  assert.equal(assistantKind('Стрежевская ещё не оплатила тренировку'),'record');
});

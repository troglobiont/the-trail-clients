import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantKind, suggestAssistantClients } from '../src/assistant.js';

const clients = [
  { id:'polina', name:'Стримовская Полина', aliases:['Polina Strimovskaia'] },
  { id:'another', name:'Иванова Полина' },
  { id:'merged', name:'Тремовская Полина', mergedInto:'polina' }
];

test('assistant proposes the card for a split or misspelled surname and asks for a choice', () => {
  for (const text of ['С Тремовской нужно связаться', 'Стремовской нужно оплатить занятие', 'Тримовская оплатила занятие']) {
    assert.deepEqual(suggestAssistantClients(text, clients), { selected:'', suggestions:['polina'] });
  }
  assert.deepEqual(suggestAssistantClients('Спросить Стримовскую о тренировке',clients), { selected:'polina', suggestions:['polina'] });
  assert.equal(suggestAssistantClients('Strimovskaia Polina',clients).selected,'polina');
});

test('assistant retains multiple clients when it only recognizes their shared name', () => {
  assert.deepEqual(suggestAssistantClients('Спросить о самочувствии',clients), { selected:'', suggestions:[] });
  assert.deepEqual(suggestAssistantClients('Спросить Полину',clients), { selected:'', suggestions:['polina','another'] });
  assert.deepEqual(suggestAssistantClients('Спросить Полина',clients), { selected:'', suggestions:['polina','another'] });
  assert.equal(suggestAssistantClients('Полина Стримовская',clients).selected,'polina');
});

test('assistant distinguishes a requested payment follow-up from a reported receipt', () => {
  assert.equal(assistantKind('Стремовской нужно оплатить персональную тренировку на улице'),'task');
  assert.equal(assistantKind('Напомни Иванову оплатить тренировку'),'task');
  assert.equal(assistantKind('Стремовская оплатила персоналку в зале'),'payment');
  assert.equal(assistantKind('Стремовская ещё не оплатила тренировку'),'record');
});

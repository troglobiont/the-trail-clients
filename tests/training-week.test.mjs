import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, emptyState, exportState, parseImport } from '../src/core.js';
import { cloudData } from '../src/cloud-state.js';
import { localDate } from '../src/model-utils.js';
import { createStore } from '../src/store.js';
import {
  TRAINING_WEEK_MAX_BYTES, applyTrainingWeek, parseTrainingWeek, previewTrainingWeek,
  trainingWeekDays, trainingWeekRevisions
} from '../src/training-week.js';

const example = () => ({
  format: 'the-trail-training-week', schemaVersion: 1, status: 'approved',
  group: {id: 'test-group', name: 'Тестовая группа'}, weekStart: '2026-11-23',
  revision: 1, previousRevision: null, approvedAt: '2026-11-22T15:00:00+01:00',
  source: {planId: '100', planTitle: 'Тестовый план', checkedAt: '2026-11-22T14:30:00+01:00'},
  sessions: [
    {
      id: 'tempo', sourceId: '200', day: '2026-11-24', title: 'Темповые отрезки',
      purpose: 'Ровный темп', warmup: '15 мин', main: '3 × 5 мин\nМежду отрезками 2 мин',
      cooldown: '10 мин', duration: '44 мин', intensity: '90–94% LTHR',
      variants: [{label: 'Меньший объём', protocol: '2 × 5 мин'}]
    },
    {id: 'drills', sourceId: '201', day: '2026-11-24', title: 'Беговые упражнения'}
  ],
  restDays: ['2026-11-27']
});
const normalized = value => parseTrainingWeek(JSON.stringify(value));
const next = () => {
  const week = example();
  const [tempo] = week.sessions;
  return {
    ...week, revision: 2, previousRevision: 1,
    sessions: [
      {...tempo, day: '2026-11-25', main: '4 × 4 мин'},
      {id: 'easy', sourceId: '202', day: '2026-11-26', title: 'Лёгкий бег'}
    ],
    restDays: ['2026-11-28']
  };
};

test('week displays all seven days in Belgrade, keeps prescribed intensity and distinguishes rest from unknown', () => {
  const week = normalized(example());
  assert.equal(week.sessions.find(session => session.id === 'tempo').intensity, '90–94% LTHR');
  assert.equal(week.sessions.find(session => session.id === 'drills').duration, '');
  const days = trainingWeekDays(week, localDate(new Date('2026-11-23T23:05:00Z')));
  assert.equal(days.length, 7);
  assert.deepEqual(days.find(day => day.today).sessions.map(session => session.id), ['drills', 'tempo']);
  assert.equal(days[0].rest, false);
  assert.equal(days[4].rest, true);
  assert.equal(trainingWeekDays(week, '2026-11-30').some(day => day.today), false);
});

test('drafts, malformed content, out-of-week dates, duplicated IDs and sessions on rest days are rejected', () => {
  assert.throws(() => parseTrainingWeek('not JSON'), /JSON/);
  assert.throws(() => parseTrainingWeek('а'.repeat(TRAINING_WEEK_MAX_BYTES / 2 + 1)), /128 КБ/);
  for (const [change, expected] of [
    [week => { week.status = 'draft'; }, /утверждённую/],
    [week => { week.weekStart = '2026-11-24'; }, /понедельник/],
    [week => { week.sessions[0].day = '2026-11-30'; }, /границы недели/],
    [week => { week.sessions[1].id = week.sessions[0].id; }, /уникальный постоянный ID/],
    [week => { week.sessions[1].sourceId = week.sessions[0].sourceId; }, /ID карточек/],
    [week => { week.restDays.push(week.sessions[0].day); }, /дни отдыха/],
    [week => { week.source.checkedAt = '2026-11-31T12:00:00+01:00'; }, /Сверено/]
  ]) {
    const week = example();
    change(week);
    assert.throws(() => normalized(week), expected);
  }
});

test('duplicate packages are idempotent, moved sessions retain identity and older revisions stay read-only', () => {
  const state = emptyState();
  assert.throws(() => applyTrainingWeek(state, next()), /первую редакцию/);
  assert.equal(trainingWeekRevisions(state).length, 0);
  assert.equal(applyTrainingWeek(state, example()), true);
  const repeat = example();
  repeat.sessions.reverse();
  repeat.source.planTitle = 'Переименованный тестовый план';
  repeat.source.checkedAt = '2026-11-22T14:45:00+01:00';
  assert.equal(applyTrainingWeek(state, repeat), false);
  const preview = previewTrainingWeek(state, normalized(next()));
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.changes.updated.map(session => session.id), ['tempo']);
  assert.deepEqual(preview.changes.added.map(session => session.id), ['easy']);
  assert.deepEqual(preview.changes.removed.map(session => session.id), ['drills']);
  assert.deepEqual(preview.changes.restAdded, ['2026-11-28']);
  assert.equal(applyTrainingWeek(state, next()), true);
  assert.equal(applyTrainingWeek(state, example()), false);
  const [old, current] = trainingWeekRevisions(state);
  assert.equal(old.sessions.find(session => session.id === 'tempo').day, '2026-11-24');
  assert.equal(current.sessions.find(session => session.id === 'tempo').day, '2026-11-25');
});

test('conflicts never replace the active revision', () => {
  const state = emptyState();
  applyTrainingWeek(state, example());
  const altered = example();
  altered.sessions[0].intensity = '90–92% LTHR';
  assert.equal(previewTrainingWeek(state, normalized(altered)).status, 'conflict');
  assert.throws(() => applyTrainingWeek(state, altered), /другим содержанием/);
  const otherGroup = next();
  otherGroup.group.id = 'other-group';
  assert.throws(() => applyTrainingWeek(state, otherGroup), /другая группа/);
  const remapped = next();
  remapped.sessions[0].id = 'new-tempo-id';
  assert.throws(() => applyTrainingWeek(state, remapped), /постоянный ID/);
  assert.equal(trainingWeekRevisions(state).length, 1);
  assert.equal(trainingWeekRevisions(state)[0].sessions.find(session => session.id === 'tempo').intensity, '90–94% LTHR');
});

test('a week survives restart and explicit backup; failed writes leave the last complete revision and other data intact', async () => {
  let disk, failed = false;
  const adapter = {
    load: async () => disk,
    save: async value => {
      if (failed) throw Error('disk unavailable');
      disk = value;
    }
  };
  const store = await createStore(adapter);
  await store.mutate(state => { createClient(state, {name: 'Тестовый клиент'}); });
  const baseline = cloudData(store.state());
  await store.mutate(state => applyTrainingWeek(state, example()));
  failed = true;
  await assert.rejects(store.mutate(state => applyTrainingWeek(state, next())), /disk unavailable/);
  assert.equal(trainingWeekRevisions(store.state()).at(-1).revision, 1);
  assert.deepEqual(cloudData(store.state()), baseline);
  const restarted = await createStore(adapter);
  assert.deepEqual(trainingWeekRevisions(restarted.state()), trainingWeekRevisions(store.state()));
  const backup = parseImport(exportState(restarted.state()));
  assert.deepEqual(trainingWeekRevisions(backup), trainingWeekRevisions(restarted.state()));
});

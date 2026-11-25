import { addDays, localDate, validDate } from './model-utils.js';

const FORMAT = 'the-trail-training-week';
export const TRAINING_WEEK_MAX_BYTES = 128 * 1024;
export const PROTOCOL_FIELDS = [
  ['purpose', 'Цель'],
  ['warmup', 'Разминка'],
  ['main', 'Основная часть'],
  ['cooldown', 'Заминка'],
  ['duration', 'Длительность'],
  ['intensity', 'Интенсивность']
];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stableId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function packageText(value, label, { required = false, max = 3000 } = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw Error('Проверь поле «' + label + '».');
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) {
    throw Error('Укажи дату, время и часовой пояс для поля «' + label + '».');
  }
  return new Date(value).toISOString();
}

function normalizeWeek(value) {
  if (!object(value) || value.format !== FORMAT || value.schemaVersion !== 1) {
    throw Error('Это не пакет тренировочной недели THE.TRAIL.');
  }
  if (value.status !== 'approved') throw Error('Пакет должен содержать утверждённую редакцию недели.');
  const { group, weekStart, revision, previousRevision, source } = value;
  if (!object(group) || !stableId(group.id)) throw Error('Укажи постоянный ID группы.');
  if (!validDate(weekStart) || new Date(weekStart + 'T12:00:00Z').getUTCDay() !== 1) {
    throw Error('Неделя должна начинаться в понедельник.');
  }
  if (!Number.isSafeInteger(revision) || revision < 1 || previousRevision !== (revision === 1 ? null : revision - 1)) {
    throw Error('Проверь номера редакции и её предшественницы.');
  }
  if (!object(source) || typeof source.planId !== 'string' || !/^\d{1,24}$/.test(source.planId)) {
    throw Error('Укажи ID плана TrainingPeaks.');
  }
  if (!Array.isArray(value.sessions)) throw Error('Укажи список тренировок недели.');
  const lastDay = addDays(weekStart, 6);
  const inWeek = day => validDate(day) && day >= weekStart && day <= lastDay;
  const ids = new Set(), sourceIds = new Set();
  const sessions = value.sessions.map(session => {
    if (!object(session) || !stableId(session.id) || ids.has(session.id)) {
      throw Error('У каждой тренировки должен быть уникальный постоянный ID.');
    }
    ids.add(session.id);
    if (!inWeek(session.day)) throw Error('Дата тренировки выходит за границы недели.');
    const sourceId = packageText(session.sourceId, 'ID тренировки в TrainingPeaks', {max: 80});
    if (sourceId) {
      if (!stableId(sourceId) || sourceIds.has(sourceId)) throw Error('Проверь ID карточек TrainingPeaks. Каждый ID должен быть уникальным.');
      sourceIds.add(sourceId);
    }
    const variants = session.variants ?? [];
    if (!Array.isArray(variants)) throw Error('Проверь список вариантов нагрузки.');
    return {
      id: session.id, sourceId, day: session.day,
      title: packageText(session.title, 'Название тренировки', {required: true, max: 180}),
      ...Object.fromEntries(PROTOCOL_FIELDS.map(([key, label]) => [key, packageText(session[key], label)])),
      variants: variants.map(variant => {
        if (!object(variant)) throw Error('Проверь вариант нагрузки.');
        return {
          label: packageText(variant.label, 'Название варианта', {required: true, max: 100}),
          protocol: packageText(variant.protocol, 'Описание варианта', {required: true})
        };
      })
    };
  });
  const restDays = value.restDays ?? [];
  if (!Array.isArray(restDays) || !restDays.every(inWeek) || new Set(restDays).size !== restDays.length
    || sessions.some(session => restDays.includes(session.day))) {
    throw Error('Проверь дни отдыха. На эти даты не должно быть тренировок.');
  }
  sessions.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id, 'en'));
  return {
    format: FORMAT, schemaVersion: 1, status: 'approved',
    group: { id: group.id, name: packageText(group.name, 'Группа', {required: true, max: 120}) },
    weekStart, revision, previousRevision,
    approvedAt: timestamp(value.approvedAt, 'Подтверждено'),
    source: {
      planId: source.planId,
      planTitle: packageText(source.planTitle, 'Название плана TrainingPeaks', {max: 180}),
      checkedAt: timestamp(source.checkedAt, 'Сверено с TrainingPeaks')
    },
    sessions, restDays: [...restDays].sort()
  };
}

export function parseTrainingWeek(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > TRAINING_WEEK_MAX_BYTES) {
    throw Error('Размер пакета недели превышает 128 КБ.');
  }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw Error('Не удалось прочитать пакет недели. Нужен файл JSON.'); }
  return normalizeWeek(value);
}

const sameWeek = (left, right) => left.group.id === right.group.id && left.weekStart === right.weekStart;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function content(week) {
  return [week.group.name, week.source.planId, week.sessions, week.restDays];
}

export function trainingWeekRevisions(state) {
  return state.settings.trainingWeek ?? [];
}

export function validateStoredTrainingWeek(state) {
  const stored = trainingWeekRevisions(state);
  if (!Array.isArray(stored)) throw Error('Некорректная история тренировочной недели.');
  return stored.map((entry, index) => {
    const week = normalizeWeek(entry);
    if (week.revision !== index + 1 || !sameWeek(week, stored[0]) || week.source.planId !== stored[0].source.planId) {
      throw Error('Нарушен порядок редакций тренировочной недели.');
    }
    return week;
  });
}

export function trainingWeekDays(week, today = localDate()) {
  return Array.from({length: 7}, (_, index) => {
    const day = addDays(week.weekStart, index);
    return {
      day, today: day === today, rest: week.restDays.includes(day),
      sessions: week.sessions.filter(session => session.day === day)
    };
  });
}

function weekChanges(current, incoming) {
  const before = new Map((current?.sessions ?? []).map(session => [session.id, session]));
  const after = new Set(incoming.sessions.map(session => session.id));
  return {
    added: incoming.sessions.filter(session => !before.has(session.id)),
    updated: incoming.sessions.filter(session => before.has(session.id) && !same(session, before.get(session.id))),
    removed: (current?.sessions ?? []).filter(session => !after.has(session.id)),
    restAdded: incoming.restDays.filter(day => !current?.restDays.includes(day)),
    restRemoved: (current?.restDays ?? []).filter(day => !incoming.restDays.includes(day))
  };
}

export function previewTrainingWeek(state, incoming) {
  const history = trainingWeekRevisions(state);
  const active = history.at(-1);
  if (active && (!sameWeek(active, incoming) || active.source.planId !== incoming.source.planId)) {
    return {status: 'conflict', reason: 'На устройстве уже сохранена другая группа, неделя или источник.'};
  }
  const saved = history.find(week => week.revision === incoming.revision);
  if (saved) {
    if (same(content(saved), content(incoming))) return {status: 'duplicate', reason: 'Эта редакция уже сохранена.'};
    return {
      status: 'conflict', reason: 'Редакция ' + saved.revision + ' уже сохранена с другим содержанием.',
      changes: weekChanges(saved, incoming)
    };
  }
  if (incoming.previousRevision !== (active?.revision ?? null)) {
    return {
      status: 'conflict',
      reason: active ? 'Следующий пакет должен обновлять редакцию ' + active.revision + '.'
        : 'Сначала загрузи первую редакцию недели.'
    };
  }
  const knownIds = new Map(history.flatMap(week => week.sessions
    .filter(session => session.sourceId).map(session => [session.sourceId, session.id])));
  if (incoming.sessions.some(session => knownIds.has(session.sourceId) && knownIds.get(session.sourceId) !== session.id)) {
    return {status: 'conflict', reason: 'У карточки TrainingPeaks изменился постоянный ID тренировки в пакете.'};
  }
  return {status: 'ready', changes: weekChanges(active, incoming)};
}

export function applyTrainingWeek(state, incoming) {
  const week = normalizeWeek(incoming);
  const preview = previewTrainingWeek(state, week);
  if (preview.status === 'duplicate') return false;
  if (preview.status === 'conflict') throw Error(preview.reason);
  state.settings.trainingWeek = [...trainingWeekRevisions(state), week];
  return true;
}

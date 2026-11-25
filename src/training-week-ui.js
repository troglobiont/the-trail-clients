import { addDays, localDate, TIMEZONE } from './model-utils.js';
import {
  PROTOCOL_FIELDS, TRAINING_WEEK_MAX_BYTES, applyTrainingWeek, parseTrainingWeek,
  previewTrainingWeek, trainingWeekDays, trainingWeekRevisions
} from './training-week.js';

export const TRAINING_WEEK_ROUTE = '#todo/schedule/training-week';
const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short'
});
const dayLabel = day => dayFormat.format(new Date(day + 'T12:00:00Z'));
const revisionRoute = week => TRAINING_WEEK_ROUTE + '/' + week.revision;
const noProtocol = 'Утверждённого протокола на сегодня нет.';

export function createTrainingWeekUI({state, el, append, text, button, row, formatDate, modal, navigate, save, message, weekPanel}) {
  const weekRange = week => formatDate(week.weekStart) + ' — ' + formatDate(addDays(week.weekStart, 6)) + ' · ' + week.weekStart.slice(0, 4);
  const sourceLabel = source => [source.planTitle, 'ID ' + source.planId].filter(Boolean).join(' · ');
  const sectionSchedule = () => button('← К расписанию', () => navigate('#todo/schedule'), 'subtle');
  const sessionRoute = (week, session) => revisionRoute(week) + '/' + session.id;

  function sessionSummary(week, session) {
    return append(button('', () => navigate(sessionRoute(week, session)), 'task-tile'),
      el('strong', session.title, 'task-title'));
  }

  function scheduleEntry() {
    const week = trainingWeekRevisions(state()).at(-1);
    if (!week) {
      return append(el('section', null, 'panel stack'),
        row(button('Неделя группы', () => navigate(TRAINING_WEEK_ROUTE)), text('Неделя ещё не загружена.')));
    }
    const today = trainingWeekDays(week).find(day => day.today);
    return append(el('section', null, 'panel stack'),
      append(el('div', null, 'row between'),
        el('h2', 'Сегодня · ' + week.group.name),
        button('Неделя группы', () => navigate(TRAINING_WEEK_ROUTE), 'subtle')),
      today?.sessions.length
        ? append(el('div', null, 'stack'), ...today.sessions.map(session => sessionSummary(week, session)))
        : text(today?.rest ? 'День отдыха' : noProtocol),
      !today && text('Сохранённая неделя · ' + weekRange(week)));
  }

  function protocol(session) {
    return append(el('dl', null, 'training-protocol'),
      ...PROTOCOL_FIELDS.flatMap(([key, label]) => [
        el('dt', label), el('dd', session[key] || 'Не указано', session[key] ? 'feature-text' : 'muted')
      ]),
      el('dt', 'Варианты нагрузки'),
      session.variants.length
        ? append(el('dd'), append(el('ul', null, 'training-variants'),
          ...session.variants.map(variant => append(el('li'), el('strong', variant.label), text(variant.protocol, 'feature-text')))))
        : el('dd', 'Не указаны', 'muted'));
  }

  function sessionDescription(session) {
    return [
      ...PROTOCOL_FIELDS.flatMap(([key,label]) => session[key] ? [label + '\n' + session[key]] : []),
      ...session.variants.map(variant => variant.label + '\n' + variant.protocol)
    ].join('\n\n');
  }

  function provenance(week) {
    return append(el('div', null, 'panel stack'),
      text('TrainingPeaks · ' + sourceLabel(week.source)),
      text('Сверено · ' + formatDate(week.source.checkedAt, true)),
      text('Утверждено · ' + formatDate(week.approvedAt, true)),
      text('Сохранено на этом устройстве'));
  }

  function changesList(changes) {
    const nodes = [];
    for (const [label, entries] of [
      ['Добавлены', changes.added], ['Изменены', changes.updated], ['Сняты', changes.removed]
    ]) {
      if (entries.length) nodes.push(text(label + ' · ' + entries.map(entry => dayLabel(entry.day) + ' — ' + entry.title).join(' / ')));
    }
    if (changes.restAdded.length) nodes.push(text('Добавлены дни отдыха · ' + changes.restAdded.map(dayLabel).join(', ')));
    if (changes.restRemoved.length) nodes.push(text('Убраны дни отдыха · ' + changes.restRemoved.map(dayLabel).join(', ')));
    return nodes.length ? append(el('div', null, 'stack'), ...nodes) : null;
  }

  function importWeek() {
    modal('Загрузить неделю', (form, setEnabled) => {
      const picker = el('input');
      picker.type = 'file';
      picker.accept = '.json,application/json';
      const preview = el('div', null, 'stack');
      preview.setAttribute('aria-live', 'polite');
      let candidate;
      append(form, text('Выбери JSON-пакет, сверенный с TrainingPeaks и утверждённый для этой группы.'),
        append(el('label', 'Файл недели'), picker), preview);
      setEnabled(false);
      picker.addEventListener('change', async () => {
        const file = picker.files[0];
        setEnabled(false);
        candidate = null;
        preview.replaceChildren();
        if (!file) return;
        try {
          if (file.size > TRAINING_WEEK_MAX_BYTES) throw Error('Размер пакета недели превышает 128 КБ.');
          const contents = await file.text();
          if (picker.files[0] !== file || !picker.isConnected) return;
          const week = parseTrainingWeek(contents);
          const result = previewTrainingWeek(state(), week);
          append(preview, el('h3', week.group.name + ' · редакция ' + week.revision),
            text(weekRange(week) + ' · ' + sourceLabel(week.source)),
            text('Сверено с TrainingPeaks · ' + formatDate(week.source.checkedAt, true)),
            result.reason && text(result.reason, result.status === 'conflict' ? 'danger-text small' : undefined),
            result.changes && changesList(result.changes));
          if (result.status !== 'ready') return;
          for (const session of week.sessions) {
            preview.append(append(el('details', null, 'fold'),
              el('summary', dayLabel(session.day) + ' · ' + session.title),
              append(el('div', null, 'fold-body'), protocol(session))));
          }
          candidate = week;
          setEnabled(true);
        } catch (error) {
          if (picker.files[0] === file && picker.isConnected) preview.append(text(error.message, 'danger-text small'));
        }
      });
      return async () => {
        const week = candidate;
        if (!week) throw Error('Сначала проверь пакет недели.');
        picker.disabled = true;
        try {
          const changed = await save(draft => applyTrainingWeek(draft, week));
          message(changed ? 'Редакция недели сохранена на устройстве.' : 'Эта редакция уже сохранена.');
        } finally {
          picker.disabled = false;
        }
      };
    }, {saveLabel: 'Применить редакцию'});
  }

  function page(route,{canImport=true,calendar=false}={}) {
    const history = trainingWeekRevisions(state());
    const active = history.at(-1);
    const [, version, sessionId] = route.slice(TRAINING_WEEK_ROUTE.length).split('/');
    const week = version ? history.find(entry => String(entry.revision) === version) : active;
    if (version && !week) return append(el('div', null, 'stack'), row(sectionSchedule()), text('Редакция недели не найдена.'));
    const panel = append(el('div', null, 'stack-lg'),
      append(el('div', null, 'stack'), !calendar && row(sectionSchedule()), el('h1', 'Неделя группы'),
        week && text(week.group.name + ' · ' + weekRange(week))));
    if (!week) return append(panel, text('Утверждённая неделя группы пока не загружена.'),
      canImport && row(button('Загрузить неделю', importWeek, 'primary')));
    if (sessionId && !week.sessions.some(session => session.id === sessionId)) {
      panel.append(text('Тренировка в этой редакции не найдена.'));
    }
    append(panel, append(el('div', null, 'row between'),
      row(el('span', 'Редакция ' + week.revision, 'chip'), week !== active && el('span', 'Архив', 'chip')),
      week === active ? canImport && button('Загрузить редакцию', importWeek) :
        button('К текущей редакции', () => navigate(TRAINING_WEEK_ROUTE), 'subtle')),
      weekPanel(week,{preferredId:sessionId,describe:sessionDescription,
        emptyDay:day=>week.restDays.includes(day)?'День отдыха':'Протокол не указан'}));
    if (canImport) panel.append(append(el('details', null, 'fold'), el('summary', 'Источник и редакция'),
      append(el('div', null, 'fold-body'), provenance(week))));
    if (canImport && week === active && history.length > 1) {
      panel.append(append(el('details', null, 'fold'), el('summary', 'Предыдущие редакции'),
        append(el('div', null, 'fold-body stack'), ...history.slice(0, -1).reverse().map(entry =>
          row(button('Редакция ' + entry.revision + ' · ' + formatDate(entry.approvedAt, true),
            () => navigate(revisionRoute(entry)), 'subtle'))))));
    }
    return panel;
  }

  return { scheduleEntry, page };
}

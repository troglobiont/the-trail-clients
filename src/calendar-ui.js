import {addDays, localDate, TIMEZONE} from './model-utils.js';
import {linkCalendarTask, normalizeSearch} from './core.js';

const clock = new Intl.DateTimeFormat('ru-RU', {timeZone:TIMEZONE, hour:'2-digit', minute:'2-digit'});

export function isSchedulingTask(task) {
  return !task.pauseContact && (task.calendarEvent ||
    /согласов|назнач|договор/u.test(task.title.toLowerCase()) && /заняти|трениров/u.test(task.title.toLowerCase()));
}

export function taskCalendarChoices(events, clients, task, tasks) {
  const client = clients[task.clientId];
  const words = name => String(name).trim().split(/\s+/u).map(normalizeSearch).filter(Boolean);
  const names = person => [person.name, ...(person.aliases || [])].map(words);
  const signature = parts => [...parts].sort().join(' ');
  const aliases = names(client);
  const others = Object.values(clients).filter(c => c.id !== client.id && !c.mergedInto);
  const reserved = new Set(Object.values(tasks).filter(t => t.id !== task.id).map(t => t.calendarEvent?.id));
  return events.filter(event => {
    if (reserved.has(event.id)) return false;
    if (event.clientId) return event.clientId === task.clientId;
    const person = words(event.title.split('·')[1] || '');
    if (person.length > 1) return aliases.some(alias => signature(alias) === signature(person));
    return person.length === 1 && aliases.some(alias => alias.includes(person[0])) &&
      !others.some(other => names(other).some(alias => alias.includes(person[0])));
  });
}

export function createCalendarUI({state, service, el, append, button, row, field, input, select, text, modal, commit, formatDate}) {
  let cached, loading;
  const load = (force = false) => {
    if (loading) return loading;
    if (!force && cached?.until > Date.now()) return Promise.resolve(cached.value);
    const from = localDate(), to = addDays(from, 30);
    loading = service('/calendar/list', {from, to}).then(value => {
      if (value.error) throw Error(value.error);
      if (!Array.isArray(value.events)) throw Error('Не удалось прочитать расписание');
      cached = {value, until:Date.now() + 60_000};
      return value;
    }).finally(() => { loading = null; });
    return loading;
  };
  const timeRange = event => clock.format(new Date(event.start)) + '–' + clock.format(new Date(event.end));
  const eventLink = (event, label) => {
    if (!/^https:\/\/calendar\.google\.com\/calendar\/event\?eid=[A-Za-z0-9_-]+$/u.test(event.url||'')) return null;
    const link = el('a', label, 'calendar-link');
    link.href = event.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  };
  const modeHint = data => data.mode === 'snapshot'
    ? 'Снимок календаря · '+formatDate(data.asOf)+'. Автообновление пока не подключено.'
    : data.mode === 'not-connected' ? 'Google Календарь ещё не подключён.' : '';

  function schedule() {
    const list = el('div', null, 'stack'), status = text(''), box = el('section', null, 'stack');
    status.setAttribute('role', 'status');
    const update = async force => {
      status.textContent = 'Загружаю расписание…';
      list.replaceChildren();
      try {
        const data = await load(force);
        status.textContent = modeHint(data) || (data.events.length ? '' : 'На ближайшие 30 дней персональных тренировок нет.');
        let previousDay;
        for (const event of data.events) {
          const day = localDate(new Date(event.start));
          if (day !== previousDay) list.append(el('h3', formatDate(day), 'calendar-day'));
          previousDay = day;
          const name = event.title.split('·')[1]?.trim() || event.title;
          list.append(append(el('article', null, 'panel calendar-event'),
            text(timeRange(event), 'calendar-time'),
            append(el('div'),eventLink(event,name)||el('strong',name),event.location&&text(event.location))));
        }
      } catch(error) {
        status.textContent = error.message;
      }
    };
    append(box,append(el('div',null,'page-title'),el('h2','Персональные тренировки'),button('Обновить',()=>update(true),'subtle')),status,list);
    void update(false);
    return box;
  }

  function book(task, onSaved) {
    const client = state().clients[task.clientId];
    modal('Назначить тренировку', (form, enable) => {
      const status = text('Загружаю расписание…'), options = select([], ''), liveForm = el('div',null,'stack');
      status.setAttribute('role','status');
      const choiceField = field('Тренировка', options);
      choiceField.hidden = true; liveForm.hidden = true;
      const today = localDate(), day = input('date', today), time = input('time');
      const minutes = input('number', '60'), place = input('text', '', 'Место тренировки');
      day.min = today; minutes.min = '15'; minutes.max = '180'; place.maxLength = 180;
      append(liveForm, row(field('Дата',day), field('Время Белграда',time)), field('Длительность, мин',minutes), field('Место',place));
      append(form, text(client.name,'task-title'), status, choiceField, liveForm);
      let choices = [], ready = false;
      const refresh = () => {
        liveForm.hidden = options.value !== 'new';
        enable(ready && !!options.value && (liveForm.hidden || day.value && time.value && minutes.value && minutes.validity.valid));
      };
      form.addEventListener('input',refresh);
      queueMicrotask(refresh);
      void load().then(data => {
        const s = state();
        choices = taskCalendarChoices(data.events, s.clients, task, s.tasks);
        const items = choices.map(event => [event.id, [formatDate(event.start), timeRange(event), event.location].filter(Boolean).join(' · ')]);
        if (data.mode === 'live') items.push(['new','Создать в Google Календаре']);
        for (const [value,label] of items) {
          const option = el('option',label); option.value = value; options.append(option);
        }
        choiceField.hidden = !items.length;
        status.textContent = [modeHint(data), choices.length ? 'Можно связать задачу с уже записанной тренировкой.' :
          data.mode === 'live' ? 'Выбери дату и время.' : 'Подходящей тренировки в расписании пока нет.'].filter(Boolean).join(' ');
        ready = !!items.length;
        refresh();
      }).catch(error => { status.textContent = error.message; });
      return async () => {
        let event = choices.find(item => item.id === options.value);
        if (options.value === 'new') {
          const response = await service('/calendar/book', {taskId:task.id, clientId:client.id, clientName:client.name,
            day:day.value, time:time.value, minutes:Number(minutes.value), location:place.value});
          if (response.error) throw Error(response.error);
          event = response.event;
          cached = null;
        }
        if (!event) throw Error('Выбери тренировку');
        await commit(s => linkCalendarTask(s, task.id, event),false);
      };
    },{saveLabel:'Подтвердить и завершить задачу',onSaved});
  }

  function linked(task) {
    if (!Number.isFinite(Date.parse(task.calendarEvent?.start))) return null;
    const event = task.calendarEvent;
    return append(el('div',null,'row'),text(formatDate(event.start,true)+' · Тренировка'),eventLink(event,'Календарь'));
  }

  return {schedule, book, linked};
}

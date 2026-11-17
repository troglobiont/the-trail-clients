import {addDays, localDate, TIMEZONE} from './model-utils.js';
import {linkCalendarTask, normalizeSearch} from './core.js';
import {accounting, activeService, clientServices, money, serviceBalance, tariffLabel} from './accounting.js';

const clock = new Intl.DateTimeFormat('ru-RU', {timeZone:TIMEZONE, hour:'2-digit', minute:'2-digit'});

export function isSchedulingTask(task) {
  return !task.pauseContact && (task.calendarEvent ||
    /согласов|назнач|договор/u.test(task.title.toLowerCase()) && /заняти|трениров/u.test(task.title.toLowerCase()));
}

export function taskCalendarChoices(events, clients, task, tasks) {
  const reserved = new Set(Object.values(tasks).filter(t => t.id !== task.id).map(t => t.calendarEvent?.id));
  return events.filter(event => !reserved.has(event.id) && calendarClient(event,clients)?.id === task.clientId);
}

const calendarName = event => event.title.split('·')[1]?.trim() || event.title;

export function calendarClient(event, clients, linkedId) {
  const available = client => client && !client.mergedInto && (!client.role || client.role === 'Клиент');
  if (linkedId || event.clientId) {
    const direct = clients[linkedId || event.clientId];
    const client = direct?.mergedInto ? clients[direct.mergedInto] : direct;
    return available(client) ? client : undefined;
  }
  const words = name => name.trim().split(/\s+/u).map(normalizeSearch).filter(Boolean);
  const signature = parts => [...parts].sort().join(' ');
  const person = words(calendarName(event)), target = signature(person);
  if (!person.length) return;
  const matches = Object.values(clients).filter(client => available(client) && [client.name,...(client.aliases || [])].some(name => {
    const parts = words(name);
    return person.length > 1 ? signature(parts) === target : parts.includes(person[0]);
  }));
  return matches.length === 1 ? matches[0] : undefined;
}

async function sessionIds(eventId) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(eventId)));
  const key = Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return {sessionId:'calendar-session-'+key,paymentId:'calendar-payment-'+key};
}

export function calendarPlace(location) {
  const name = location?.toLowerCase() || '';
  if (/\bgym\b|teretana|(^|\s)зал(\s|$)|fitness|фитнес/u.test(name)) return 'Зал';
  if (/кал[еи]мегдан|kalemegdan|улица|outdoor|\bpark\b|парк|ада циганлия|ada ciganlija/u.test(name)) return 'Улица';
  return null;
}

export function createCalendarUI({state, service, el, append, button, row, field, input, select, text, modal, commit, formatDate,
    navigate, openClient, searchClients, scheduledSession, addScheduledTariff}) {
  let cached, loading;
  const selectedClients = new Map();
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
          list.append(append(button('',()=>navigate('#todo/schedule/'+encodeURIComponent(event.id)),'panel calendar-event'),
            text(timeRange(event), 'calendar-time'),
            append(el('div'),el('strong',calendarName(event)),event.location&&text(event.location))));
        }
      } catch(error) {
        status.textContent = error.message;
      }
    };
    append(box,append(el('div',null,'page-title'),el('h2','Персональные тренировки'),button('Обновить',()=>update(true),'subtle')),status,list);
    void update(false);
    return box;
  }

  function session(eventId) {
    const content = el('section',null,'stack-lg');
    const page = append(el('div',null,'stack-lg'),button('← К расписанию',()=>navigate('#todo/schedule'),'back subtle'),content);
    const display = (event, ids) => {
      const s = state(), date = localDate(new Date(event.start));
      const {services,operations} = accounting(s);
      const operation = operations[ids.sessionId];
      const recorded = operation && !operation.voided;
      const existingClientId = operation && services[operation.serviceId]?.clientId;
      const linkedTask = Object.values(s.tasks).find(task=>task.calendarEvent?.id===event.id);
      const client = calendarClient(event,s.clients,existingClientId || selectedClients.get(event.id) || event.clientId || linkedTask?.clientId);
      const place = calendarPlace(event.location);
      const tariffs = client ? clientServices(s,client.id).filter(tariff=>tariff.kind==='personal' && !tariff.oneOff
        && activeService(tariff,date) && (!place || tariff.place===place)) : [];
      const tariff = recorded ? services[operation.serviceId] : tariffs.length===1 ? tariffs[0] : null;
      const credit = tariff && serviceBalance(s,tariff.id).balance;
      const started = Date.parse(event.start) <= Date.now();
      const pickClient = () => modal('Выбрать клиента',form=>{
        const query = input('search',calendarName(event),'Поиск (фамилия имя)');
        query.setAttribute('aria-label','Поиск (фамилия имя)');
        const matches = el('div',null,'stack');
        const update = () => {
          const found = searchClients(query.value).slice(0,10);
          matches.replaceChildren(...found.map(person=>button(person.name,()=>{
            selectedClients.set(event.id,person.id);
            form.closest('dialog').close();display(event,ids);
          },'client-tile')), ...(!found.length?[text('Клиенты не найдены')]:[]));
        };
        query.addEventListener('input',update);update();append(form,query,matches);
      },{saveLabel:null});

      content.replaceChildren(el('h1','Персональная тренировка'),
        append(el('section',null,'panel stack calendar-detail'),
          append(el('div',null,'row between'),
            client ? button(client.name,()=>openClient(client.id),'calendar-client') : el('h2',calendarName(event)),
            recorded && el('span','Проведена','chip')),
          text([date===localDate()?'Сегодня':null,formatDate(date),timeRange(event)].filter(Boolean).join(' · '),'calendar-time'),
          event.location && el('p',event.location),
          !client && button('Выбрать клиента',pickClient,'subtle'),
          eventLink(event,'Открыть в Google Календаре')));
      if (!client) return;
      const actions = el('section',null,'stack calendar-actions');
      append(actions,tariff && append(el('div',null,'row between'),el('h2',tariffLabel(tariff)),
        el('strong',money(recorded?operation.amount:tariff.rate,tariff.currency),'money-amount')),
        credit > 0 && text('Остаток аванса · '+money(credit,tariff.currency)),
        recorded && credit < 0 && text('К оплате по тарифу · '+money(-credit,tariff.currency)));
      if (!recorded) {
        if (tariffs.length) {
          const complete = button('Тренировка состоялась',()=>scheduledSession(client.id,{...ids,date},tariffs),'primary');
          complete.disabled = !started;
          append(actions,tariffs.length>1&&text('Тариф можно выбрать при записи'),complete);
        } else if (started) {
          append(actions,text('На дату тренировки нет подходящего персонального тарифа'),
            button('Добавить тариф',()=>addScheduledTariff(client.id,{date,place}),'subtle'));
        }
      }
      if (actions.children.length) content.append(actions);
    };
    content.append(text('Загружаю тренировку…'));
    void Promise.all([load(),sessionIds(eventId)]).then(([data,ids])=>{
      const event = data.events.find(item=>item.id===eventId);
      if (!event) throw Error('Тренировка не найдена в расписании');
      display(event,ids);
    }).catch(error=>content.replaceChildren(text(error.message)));
    return page;
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

  return {schedule, session, book, linked};
}
